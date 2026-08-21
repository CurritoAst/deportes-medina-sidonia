'use strict';
/* F3 contra BD REAL: abonos/carnet/QR del socio y endpoints del torno.
   MSD_DB_HOST=127.0.0.1 MSD_DB_PORT=3307 MSD_DB_NAME=deportes_pruebas MSD_DB_USER=root MSD_DB_PASSWORD= node --test test/torno-e2e.test.js
   ¡BD de PRUEBAS! Borra y recrea las tablas. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const HAY_BD = !!(process.env.MSD_DB_HOST || process.env.MSD_DB_NAME);
if (!HAY_BD) {
  test('torno e2e (omitido: sin MSD_DB_*)', { skip: 'define MSD_DB_* hacia una BD de PRUEBAS' }, () => {});
} else {
  process.env.MSD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'msd-torno-'));
  process.env.MSD_URL_PUBLICA = 'http://localhost';
  process.env.MSD_HTTPS = '0';
  delete process.env.MSD_SMTP_HOST;
  const TOKEN = 'f'.repeat(64);
  process.env.MSD_TOKEN_TORNO = `torno-test:${TOKEN}`;

  const bd = require('../lib/bd');
  const { migrar } = require('../migrar');
  const { crearRouter } = require('../lib/http');
  const sesion = require('../lib/sesion');
  const tornoAuth = require('../lib/torno-auth');
  const limite = require('../lib/limite');
  const authRutas = require('../lib/auth-rutas');
  const abonosRutas = require('../lib/abonos-rutas');
  const tornoRutas = require('../lib/torno-rutas');
  const token = require('../lib/token');
  const { contieneSecretos } = require('../lib/vistas');
  const clave = require('../lib/clave');

  let srv, puerto, cookieAdmin = '', cookieVecino = '';
  const difundidos = [];
  const CSRF = { 'X-Requested-With': 'MSD', Origin: 'http://localhost' };

  function pedir(metodo, ruta, cuerpo, headers, cookie) {
    return new Promise((resolve, reject) => {
      const datos = cuerpo === undefined ? null : JSON.stringify(cuerpo);
      const h = Object.assign({}, datos ? { 'Content-Type': 'application/json' } : {}, cookie ? { Cookie: cookie } : {}, headers || {});
      const req = http.request({ host: '127.0.0.1', port: puerto, method: metodo, path: ruta, headers: h }, (res) => {
        let b = ''; res.on('data', (d) => b += d); res.on('end', () => {
          let j = null; try { j = JSON.parse(b); } catch (e) { /* */ }
          resolve({ status: res.statusCode, body: j, texto: b, headers: res.headers });
        });
      });
      req.on('error', reject); if (datos) req.write(datos); req.end();
    });
  }
  const cookieDe = (res) => { const sc = res.headers['set-cookie']; const m = sc && String(sc[sc.length - 1]).match(/^(msd_sid|__Host-msd_sid)=([^;]*)/); return m ? `${m[1]}=${m[2]}` : ''; };

  let vecinoId, adminId;

  test.before(async () => {
    const tablas = await bd.consulta("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()");
    await bd.consulta('SET FOREIGN_KEY_CHECKS = 0');
    for (const f of tablas) await bd.consulta(`DROP TABLE IF EXISTS \`${f.t}\``);
    await bd.consulta('SET FOREIGN_KEY_CHECKS = 1');
    await migrar();
    const router = crearRouter({ urlPublica: 'http://localhost', autenticarSesion: (req, res) => sesion.autenticar(req, res), autenticarTorno: (req) => Promise.resolve(tornoAuth.autenticar(req)) });
    authRutas.montar(router);
    authRutas.anadirExtras(abonosRutas.extrasUsuario);
    tornoRutas.montar(router, { difundirAcceso: (e) => difundidos.push(e) });
    abonosRutas.montar(router, { difundirAcceso: (e) => difundidos.push(e) });
    srv = http.createServer((req, res) => {
      const ruta = new URL(req.url, 'http://x').pathname;
      router.despachar(req, res, ruta, { ip: limite.ipCliente(req) }).then((ok) => { if (!ok) { res.writeHead(404); res.end(); } });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    puerto = srv.address().port;
    // admin y vecino verificados directamente en BD
    const ahora = new Date();
    const ra = await bd.consulta("INSERT INTO usuarios (email, nombre, rol, clave_hash, email_verificado_en) VALUES ('admin@x.es','Admin','admin',?,?)", [await clave.hashear('AdminClaveLarga2026'), ahora]);
    adminId = ra.insertId;
    const rv = await bd.consulta("INSERT INTO usuarios (email, nombre, rol, clave_hash, email_verificado_en, fecha_nacimiento) VALUES ('carmen@x.es','Carmen Aragón','vecino',?,?,'1985-04-12')", [await clave.hashear('VecinaClaveLarga2026'), ahora]);
    vecinoId = rv.insertId;
    const la = await pedir('POST', '/api/auth/entrar', { email: 'admin@x.es', clave: 'AdminClaveLarga2026' }, CSRF); cookieAdmin = cookieDe(la);
    const lv = await pedir('POST', '/api/auth/entrar', { email: 'carmen@x.es', clave: 'VecinaClaveLarga2026' }, CSRF); cookieVecino = cookieDe(lv);
    assert.ok(cookieAdmin && cookieVecino, 'sesiones de prueba');
  });
  test.after(async () => { srv.close(); await bd.cerrar(); });

  test('sin abono: /api/mi/qr → 403 SIN_ABONO; /yo trae abono null', async () => {
    const r = await pedir('GET', '/api/mi/qr', undefined, {}, cookieVecino);
    assert.equal(r.status, 403); assert.equal(r.body.codigo, 'SIN_ABONO');
    const yo = await pedir('GET', '/api/auth/yo', undefined, {}, cookieVecino);
    assert.equal(yo.body.usuario.abono, null);
  });

  test('admin da de alta el abono con pulsera; vecino no puede; UID duplicado → 409', async () => {
    assert.equal((await pedir('POST', `/api/admin/usuarios/${vecinoId}/abono`, { meses: 1, nfcUid: '1399878112' }, CSRF, cookieVecino)).status, 403);
    const r = await pedir('POST', `/api/admin/usuarios/${vecinoId}/abono`, { meses: 1, nfcUid: '1399878112' }, CSRF, cookieAdmin);
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.body.usuario.abono.vigente, true);
    assert.equal(r.body.usuario.abono.nfcUid, '1399878112');
    assert.match(r.body.usuario.abono.qrUid, /^\d{10}$/);
    assert.equal(contieneSecretos(r.body), false);           // admin tampoco ve la seed
    // otro usuario con el mismo UID
    const ro = await bd.consulta("INSERT INTO usuarios (email, nombre, rol, clave_hash, email_verificado_en) VALUES ('otro@x.es','Otro','vecino','x',NOW())");
    const dup = await pedir('PUT', `/api/admin/usuarios/${ro.insertId}/carnet`, { nfcUid: '1399878112' }, CSRF, cookieAdmin);
    assert.equal(dup.status, 409); assert.equal(dup.body.codigo, 'UID_EN_USO'); assert.equal(dup.body.de, 'Carmen Aragón');
  });

  test('/yo del vecino trae abono (solo últimos 4 del UID, sin seed); /api/mi/qr da un lote válido', async () => {
    const yo = await pedir('GET', '/api/auth/yo', undefined, {}, cookieVecino);
    assert.equal(yo.body.usuario.abono.vigente, true);
    assert.equal(yo.body.usuario.abono.nfcUltimos4, '8112');
    assert.equal('nfcUid' in yo.body.usuario.abono, false);
    assert.equal(contieneSecretos(yo.body), false);
    const q = await pedir('GET', '/api/mi/qr', undefined, {}, cookieVecino);
    assert.equal(q.status, 200, q.texto);
    assert.equal(q.body.codigos.length, 20);
    assert.equal(contieneSecretos(q.body), false);
    // el código de la ventana actual debe validar con la seed real (como hará la Pi)
    const c = await bd.uno('SELECT qr_uid, qr_seed FROM carnets WHERE usuario_id = ?', [vecinoId]);
    const T = token.ventanaActual();
    const payload = q.body.qrUid + q.body.codigos[T - q.body.desdeT];
    assert.equal(token.validar(payload, (uid) => (uid === c.qr_uid ? c.qr_seed : null)).ok, true);
    // el qrUid NO es el UID físico (revisión de seguridad)
    assert.notEqual(q.body.qrUid, '1399878112');
  });

  test('torno: sin Bearer 401; con Bearer socios (con qrSeed) + ETag/304; ping', async () => {
    assert.equal((await pedir('GET', '/api/torno/socios')).status, 401);
    const s = await pedir('GET', '/api/torno/socios', undefined, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(s.status, 200, s.texto);
    assert.equal(s.body.version, 2);
    const socio = s.body.socios.find((x) => x.nfcUid === '1399878112');
    assert.ok(socio && socio.qrSeed && /^[0-9a-f]{32}$/.test(socio.qrSeed), 'el torno SÍ recibe la seed');
    assert.equal(typeof socio.hasta, 'string'); assert.equal(socio.activo, true); assert.equal(socio.birthdate, '1985-04-12');
    const etag = s.headers.etag; assert.ok(etag);
    const s2 = await pedir('GET', '/api/torno/socios', undefined, { Authorization: `Bearer ${TOKEN}`, 'If-None-Match': etag });
    assert.equal(s2.status, 304);
    assert.equal((await pedir('GET', '/api/torno/ping', undefined, { Authorization: `Bearer ${TOKEN}` })).status, 200);
  });

  test('torno: POST acceso re-resuelve usuario por raw, es idempotente por id, y difunde', async () => {
    const id = 'a'.repeat(32);
    const ev = { id, ts: Date.now(), usuarioId: 'mentira', metodo: 'nfc', resultado: 'ok', motivo: 'Abono en vigor', direccion: 'entrada', raw: '1399878112' };
    const r1 = await pedir('POST', '/api/torno/acceso', { evento: ev }, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(r1.status, 201, r1.texto);
    assert.equal(r1.body.evento.usuarioId, String(vecinoId));   // resuelto por raw, no por el id que mandó la Pi
    assert.equal(r1.body.evento.nombre, 'Carmen Aragón');
    const r2 = await pedir('POST', '/api/torno/acceso', { evento: ev }, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(r2.status, 200); assert.equal(r2.body.duplicado, true);
    assert.equal(difundidos.length, 1);
    const n = await bd.uno('SELECT COUNT(*) AS n FROM accesos');
    assert.equal(Number(n.n), 1);
    // el vecino ve su acceso; el aforo público cuenta 1 dentro
    const mios = await pedir('GET', '/api/mi/accesos', undefined, {}, cookieVecino);
    assert.equal(mios.body.accesos.length, 1);
    const af = await pedir('GET', '/api/aforo');
    assert.equal(af.body.dentro, 1);
    // ts absurdo (año 2000) → no 4xx, se guarda con hora del servidor
    const viejo = await pedir('POST', '/api/torno/acceso', { evento: Object.assign({}, ev, { id: 'b'.repeat(32), ts: 946684800000, direccion: 'salida' }) }, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(viejo.status, 201);
  });

  test('validar desde el panel: QR del lote abre; QR con el qrUid desnudo NO abre; pulsera sí', async () => {
    const q = await pedir('GET', '/api/mi/qr', undefined, {}, cookieVecino);
    const T = token.ventanaActual();
    const payload = q.body.qrUid + q.body.codigos[T - q.body.desdeT];
    const ok = await pedir('POST', '/api/admin/torno/validar', { lectura: payload, direccion: 'entrada' }, CSRF, cookieAdmin);
    assert.equal(ok.status, 200); assert.equal(ok.body.resultado, 'ok'); assert.equal(ok.body.metodo, 'qr');
    const desnudo = await pedir('POST', '/api/admin/torno/validar', { lectura: q.body.qrUid, direccion: 'entrada' }, CSRF, cookieAdmin);
    assert.equal(desnudo.body.resultado, 'denegado');        // el qr_uid solo no es una credencial
    const pulsera = await pedir('POST', '/api/admin/torno/validar', { lectura: '1399878112', direccion: 'entrada' }, CSRF, cookieAdmin);
    assert.equal(pulsera.body.resultado, 'ok'); assert.equal(pulsera.body.metodo, 'nfc');
  });

  test('baja de abono → QR 403 y torno marca activo=false; rotar seed invalida el lote anterior', async () => {
    const q = await pedir('GET', '/api/mi/qr', undefined, {}, cookieVecino);
    await pedir('POST', `/api/admin/usuarios/${vecinoId}/carnet/rotar-qr`, {}, CSRF, cookieAdmin);
    const T = token.ventanaActual();
    const viejo = q.body.qrUid + q.body.codigos[T - q.body.desdeT];
    const c = await bd.uno('SELECT qr_uid, qr_seed FROM carnets WHERE usuario_id = ?', [vecinoId]);
    assert.equal(token.validar(viejo, (uid) => (uid === c.qr_uid ? c.qr_seed : null)).ok, false);
    const b = await pedir('POST', `/api/admin/usuarios/${vecinoId}/abono/baja`, {}, CSRF, cookieAdmin);
    assert.equal(b.status, 200); assert.equal(b.body.usuario.abono.vigente, false);
    assert.equal((await pedir('GET', '/api/mi/qr', undefined, {}, cookieVecino)).status, 403);
    const s = await pedir('GET', '/api/torno/socios', undefined, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(s.body.socios.find((x) => x.nfcUid === '1399878112').activo, false);
  });

  test('listado admin con filtros, y crear usuario desde recepción con invitación', async () => {
    const l = await pedir('GET', '/api/admin/usuarios?abono=caducado', undefined, {}, cookieAdmin);
    assert.equal(l.status, 200); assert.ok(l.body.usuarios.some((u) => u.id === vecinoId));
    assert.equal(contieneSecretos(l.body), false);
    const c = await pedir('POST', '/api/admin/usuarios', { nombre: 'Paco Reyes', email: 'paco@x.es', rol: 'vecino' }, CSRF, cookieAdmin);
    assert.equal(c.status, 201, c.texto); assert.equal(c.body.usuario.verificado, true);
    const log = fs.readFileSync(path.join(process.env.MSD_DATA_DIR, 'correos-salientes.log'), 'utf8');
    assert.match(log, /paco@x\.es[\s\S]*#\/restablecer\?token=/);
    // no puede borrarse a sí mismo ni dejar 0 admins
    assert.equal((await pedir('DELETE', `/api/admin/usuarios/${adminId}`, undefined, CSRF, cookieAdmin)).status, 400);
  });
}
