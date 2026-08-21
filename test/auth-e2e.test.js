'use strict';
/* Prueba de integración del flujo de cuentas CONTRA UNA BASE DE DATOS REAL.
   Se ejecuta solo si hay MSD_DB_* (p. ej. una MariaDB local o la de pruebas):
     MSD_DB_HOST=127.0.0.1 MSD_DB_NAME=deportes_pruebas MSD_DB_USER=root MSD_DB_PASSWORD=... node --test test/auth-e2e.test.js
   ¡USA UNA BD DE PRUEBAS! Borra y recrea las tablas.
   Sin SMTP (modo dev) los correos se vuelcan a MSD_DATA_DIR/correos-salientes.log,
   de donde el test saca los tokens de los enlaces. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const HAY_BD = !!(process.env.MSD_DB_HOST || process.env.MSD_DB_NAME);
if (!HAY_BD) {
  test('auth e2e (omitido: sin MSD_DB_*)', { skip: 'define MSD_DB_* hacia una BD de PRUEBAS para ejecutarlo' }, () => {});
} else {
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'msd-auth-'));
  process.env.MSD_DATA_DIR = DIR;
  process.env.MSD_URL_PUBLICA = 'http://localhost';
  process.env.MSD_HTTPS = '0';
  delete process.env.MSD_SMTP_HOST;
  process.env.MSD_REGISTRO_ABIERTO = '1';
  process.env.MSD_TOKEN_TORNO = 'torno-test:' + 'f'.repeat(64);

  const bd = require('../lib/bd');
  const { migrar } = require('../migrar');
  const { crearRouter } = require('../lib/http');
  const sesion = require('../lib/sesion');
  const tornoAuth = require('../lib/torno-auth');
  const limite = require('../lib/limite');
  const authRutas = require('../lib/auth-rutas');
  const { contieneSecretos } = require('../lib/vistas');

  let srv, puerto, cookie = '';
  const LOG = path.join(DIR, 'correos-salientes.log');
  const CSRF = { 'X-Requested-With': 'MSD', Origin: 'http://localhost' };

  function pedir(metodo, ruta, cuerpo, headers) {
    return new Promise((resolve, reject) => {
      const datos = cuerpo === undefined ? null : JSON.stringify(cuerpo);
      const h = Object.assign({}, datos ? { 'Content-Type': 'application/json' } : {}, cookie ? { Cookie: cookie } : {}, headers || {});
      const req = http.request({ host: '127.0.0.1', port: puerto, method: metodo, path: ruta, headers: h }, (res) => {
        let b = ''; res.on('data', (d) => b += d); res.on('end', () => {
          const sc = res.headers['set-cookie'];
          if (sc && sc.length) { const m = String(sc[sc.length - 1]).match(/^(msd_sid|__Host-msd_sid)=([^;]*)/); if (m) cookie = m[2] ? `${m[1]}=${m[2]}` : ''; }
          let j = null; try { j = JSON.parse(b); } catch (e) { /* */ }
          resolve({ status: res.statusCode, body: j, texto: b, headers: res.headers });
        });
      });
      req.on('error', reject); if (datos) req.write(datos); req.end();
    });
  }
  function ultimoToken(tipo) {   // saca el último token de un enlace #/<tipo>?token=... del log
    const log = fs.readFileSync(LOG, 'utf8');
    const re = new RegExp(`#/${tipo}\\?token=([A-Za-z0-9_-]+)`, 'g');
    let m, ult = null; while ((m = re.exec(log))) ult = m[1];
    return ult;
  }

  test.before(async () => {
    // BD de pruebas limpia
    const tablas = await bd.consulta("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()");
    await bd.consulta('SET FOREIGN_KEY_CHECKS = 0');
    for (const f of tablas) await bd.consulta(`DROP TABLE IF EXISTS \`${f.t}\``);
    await bd.consulta('SET FOREIGN_KEY_CHECKS = 1');
    const r = await migrar();
    assert.ok(r.version >= 2, 'migraciones aplicadas');
    const router = crearRouter({ urlPublica: 'http://localhost', autenticarSesion: (req, res) => sesion.autenticar(req, res), autenticarTorno: (req) => Promise.resolve(tornoAuth.autenticar(req)) });
    authRutas.montar(router);
    srv = http.createServer((req, res) => {
      const ruta = new URL(req.url, 'http://x').pathname;
      router.despachar(req, res, ruta, { ip: limite.ipCliente(req) }).then((ok) => { if (!ok) { res.writeHead(404); res.end(); } });
    });
    await new Promise((r2) => srv.listen(0, '127.0.0.1', r2));
    puerto = srv.address().port;
  });
  test.after(async () => { srv.close(); await bd.cerrar(); });

  test('registro → 202 y correo de verificación con enlace', async () => {
    const r = await pedir('POST', '/api/auth/registro', { nombre: 'Carmen Aragón Vela', email: 'Carmen@Correo.ES', telefono: '600 111 222', clave: 'una frase larga y segura', aceptaNormas: true }, CSRF);
    assert.equal(r.status, 202, r.texto);
    await new Promise((r2) => setTimeout(r2, 300));   // el envío es asíncrono (outbox)
    assert.ok(ultimoToken('verificar'), 'token de verificación en el correo');
    const u = await bd.uno('SELECT email, rol, email_verificado_en FROM usuarios WHERE email = ?', ['carmen@correo.es']);
    assert.equal(u.rol, 'vecino'); assert.equal(u.email_verificado_en, null);
  });

  test('entrar sin verificar → 403 email_no_verificado; con clave mala → 401 (sin delatar)', async () => {
    const ok = await pedir('POST', '/api/auth/entrar', { email: 'carmen@correo.es', clave: 'una frase larga y segura' }, CSRF);
    assert.equal(ok.status, 403); assert.equal(ok.body.codigo, 'EMAIL_NO_VERIFICADO');
    const mal = await pedir('POST', '/api/auth/entrar', { email: 'carmen@correo.es', clave: 'otra cosa distinta' }, CSRF);
    assert.equal(mal.status, 401); assert.equal(mal.body.codigo, 'CREDENCIALES');
    const nadie = await pedir('POST', '/api/auth/entrar', { email: 'nadie@correo.es', clave: 'otra cosa distinta' }, CSRF);
    assert.equal(nadie.status, 401); assert.equal(nadie.body.codigo, 'CREDENCIALES');
  });

  test('verificar con el token → 200 + cookie; /yo funciona; la respuesta no trae secretos', async () => {
    const r = await pedir('POST', '/api/auth/verificar', { token: ultimoToken('verificar') }, CSRF);
    assert.equal(r.status, 200, r.texto);
    assert.ok(cookie.startsWith('msd_sid='), 'cookie de sesión fijada (http dev)');
    assert.equal(r.body.usuario.email, 'carmen@correo.es');
    assert.equal(contieneSecretos(r.body), false);
    const yo = await pedir('GET', '/api/auth/yo');
    assert.equal(yo.status, 200); assert.equal(yo.body.usuario.nombre, 'Carmen Aragón Vela'); assert.equal(yo.body.usuario.verificado, true);
    assert.equal(contieneSecretos(yo.body), false);
    // el mismo token no vale dos veces
    const c2 = cookie; cookie = '';
    assert.equal((await pedir('POST', '/api/auth/verificar', { token: ultimoToken('verificar') }, CSRF)).status, 400);
    cookie = c2;
  });

  test('perfil PATCH, cambiar clave (revoca otras sesiones, mantiene la actual), salir → 401', async () => {
    const p = await pedir('PATCH', '/api/auth/perfil', { nombre: 'Carmen Aragón V.', telefono: '611222333' }, CSRF);
    assert.equal(p.status, 200); assert.equal(p.body.usuario.nombre, 'Carmen Aragón V.');
    const c = await pedir('POST', '/api/auth/clave', { actual: 'una frase larga y segura', nueva: 'otra frase todavía más larga' }, CSRF);
    assert.equal(c.status, 204);
    assert.equal((await pedir('GET', '/api/auth/yo')).status, 200);   // la actual sigue
    assert.equal((await pedir('POST', '/api/auth/salir', {}, CSRF)).status, 204);
    assert.equal((await pedir('GET', '/api/auth/yo')).status, 401);
  });

  test('login correcto con la clave nueva; 8 fallos → 423 bloqueada + correo de desbloqueo; restablecer desbloquea', async () => {
    cookie = '';
    const ok = await pedir('POST', '/api/auth/entrar', { email: 'carmen@correo.es', clave: 'otra frase todavía más larga' }, CSRF);
    assert.equal(ok.status, 200, ok.texto);
    await pedir('POST', '/api/auth/salir', {}, CSRF); cookie = '';
    // fallos: el cubo email+ip es 5/15min → tras 5 da 429; simulamos IPs distintas con XFF (socket loopback) para llegar a 8 fallos de cuenta
    let ultimo;
    for (let i = 0; i < 8; i++) {
      ultimo = await pedir('POST', '/api/auth/entrar', { email: 'carmen@correo.es', clave: 'mala' + i }, Object.assign({ 'X-Forwarded-For': `10.0.0.${i + 1}` }, CSRF));
      assert.ok([401, 423].includes(ultimo.status), `intento ${i}: ${ultimo.status}`);
    }
    const bloq = await pedir('POST', '/api/auth/entrar', { email: 'carmen@correo.es', clave: 'otra frase todavía más larga' }, Object.assign({ 'X-Forwarded-For': '10.0.0.99' }, CSRF));
    assert.equal(bloq.status, 423, bloq.texto);
    await new Promise((r2) => setTimeout(r2, 300));
    const tok = ultimoToken('restablecer');
    assert.ok(tok, 'correo de desbloqueo con enlace de restablecer');
    const rs = await pedir('POST', '/api/auth/restablecer', { token: tok, clave: 'clave nueva tras desbloqueo' }, CSRF);
    assert.equal(rs.status, 200, rs.texto);
    assert.ok(cookie, 'sesión nueva tras restablecer');
    const u = await bd.uno('SELECT fallos_login, bloqueado_hasta FROM usuarios WHERE email = ?', ['carmen@correo.es']);
    assert.equal(u.fallos_login, 0); assert.equal(u.bloqueado_hasta, null);
  });

  test('recuperar: siempre 202; una clave que NO pasa la política no quema el token; el token sirve una vez', async () => {
    cookie = '';
    assert.equal((await pedir('POST', '/api/auth/recuperar', { email: 'nadie@correo.es' }, CSRF)).status, 202);
    assert.equal((await pedir('POST', '/api/auth/recuperar', { email: 'carmen@correo.es' }, CSRF)).status, 202);
    await new Promise((r2) => setTimeout(r2, 300));
    const tok = ultimoToken('restablecer');
    // clave que contiene el nombre → 400 por política, y el enlace DEBE seguir valiendo
    const debil = await pedir('POST', '/api/auth/restablecer', { token: tok, clave: 'carmen tiene una clave larga' }, CSRF);
    assert.equal(debil.status, 400); assert.equal(debil.body.campo, 'clave');
    assert.equal(cookie, '');
    const r1 = await pedir('POST', '/api/auth/restablecer', { token: tok, clave: 'y otra clave larga distinta' }, CSRF);
    assert.equal(r1.status, 200);
    cookie = '';
    const r2 = await pedir('POST', '/api/auth/restablecer', { token: tok, clave: 'y otra clave larga distinta 2' }, CSRF);
    assert.equal(r2.status, 400);   // ya usado
  });

  test('registro cerrado (MSD_REGISTRO_ABIERTO=0) → 403; registro sin aceptar normas → 400; clave débil → 400', async () => {
    process.env.MSD_REGISTRO_ABIERTO = '0';
    assert.equal((await pedir('POST', '/api/auth/registro', { nombre: 'Paco Reyes', email: 'paco@correo.es', clave: 'una clave larga y buena', aceptaNormas: true }, CSRF)).status, 403);
    process.env.MSD_REGISTRO_ABIERTO = '1';
    assert.equal((await pedir('POST', '/api/auth/registro', { nombre: 'Paco Reyes', email: 'paco@correo.es', clave: 'una clave larga y buena', aceptaNormas: false }, CSRF)).status, 400);
    const deb = await pedir('POST', '/api/auth/registro', { nombre: 'Paco Reyes', email: 'paco@correo.es', clave: 'password123', aceptaNormas: true }, CSRF);
    assert.equal(deb.status, 400); assert.equal(deb.body.campo, 'clave');
  });

  test('bootstrap del admin por variables: solo si no hay admin', async () => {
    process.env.MSD_BOOTSTRAP_ADMIN_EMAIL = 'admin@medinasidonia.es';
    process.env.MSD_BOOTSTRAP_ADMIN_CLAVE = 'ClaveInicialMuyLarga2026';
    assert.equal(await authRutas.bootstrapAdmin(), true);
    assert.equal(await authRutas.bootstrapAdmin(), false);   // ya existe → se ignora
    cookie = '';
    const r = await pedir('POST', '/api/auth/entrar', { email: 'admin@medinasidonia.es', clave: 'ClaveInicialMuyLarga2026' }, CSRF);
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.body.usuario.rol, 'admin'); assert.equal(r.body.usuario.debeCambiarClave, true);
    assert.equal(contieneSecretos(r.body), false);
  });
}
