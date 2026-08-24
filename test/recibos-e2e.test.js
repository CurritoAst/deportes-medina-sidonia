'use strict';
/* Recibos e impagos contra BD REAL: renovación automática (domiciliación),
   marcado pagado/devuelto, plazo configurable y efecto en el torno.
   MSD_DB_HOST=127.0.0.1 MSD_DB_PORT=3307 MSD_DB_NAME=deportes_pruebas MSD_DB_USER=root MSD_DB_PASSWORD= node --test test/recibos-e2e.test.js
   ¡BD de PRUEBAS! Borra y recrea las tablas. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const HAY_BD = !!(process.env.MSD_DB_HOST || process.env.MSD_DB_NAME);
if (!HAY_BD) {
  test('recibos e2e (omitido: sin MSD_DB_*)', { skip: 'define MSD_DB_* hacia una BD de PRUEBAS' }, () => {});
} else {
  process.env.MSD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'msd-recibos-'));
  process.env.MSD_URL_PUBLICA = 'http://localhost';
  process.env.MSD_HTTPS = '0';
  delete process.env.MSD_SMTP_HOST;
  const TOKEN = 'e'.repeat(64);
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
  const recibos = require('../lib/recibos');
  const clave = require('../lib/clave');
  const { hoy, sumarDias, sumarMeses } = require('../lib/fechas');

  let srv, puerto, cookieAdmin = '', cookieVecino = '';
  const CSRF = { 'X-Requested-With': 'MSD', Origin: 'http://localhost' };
  const UID = '1399878112';

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
  const BEARER = { Authorization: `Bearer ${TOKEN}` };

  let vecinoId;

  test.before(async () => {
    const tablas = await bd.consulta("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()");
    await bd.consulta('SET FOREIGN_KEY_CHECKS = 0');
    for (const f of tablas) await bd.consulta(`DROP TABLE IF EXISTS \`${f.t}\``);
    await bd.consulta('SET FOREIGN_KEY_CHECKS = 1');
    await migrar();
    const router = crearRouter({ urlPublica: 'http://localhost', autenticarSesion: (req, res) => sesion.autenticar(req, res), autenticarTorno: (req) => Promise.resolve(tornoAuth.autenticar(req)) });
    authRutas.montar(router);
    authRutas.anadirExtras(abonosRutas.extrasUsuario);
    tornoRutas.montar(router, {});
    abonosRutas.montar(router, {});
    srv = http.createServer((req, res) => {
      const ruta = new URL(req.url, 'http://x').pathname;
      router.despachar(req, res, ruta, { ip: limite.ipCliente(req) }).then((ok) => { if (!ok) { res.writeHead(404); res.end(); } });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    puerto = srv.address().port;
    const ahora = new Date();
    await bd.consulta("INSERT INTO usuarios (email, nombre, rol, clave_hash, email_verificado_en) VALUES ('admin@x.es','Admin','admin',?,?)", [await clave.hashear('AdminClaveLarga2026'), ahora]);
    const rv = await bd.consulta("INSERT INTO usuarios (email, nombre, rol, clave_hash, email_verificado_en, fecha_nacimiento) VALUES ('paco@x.es','Paco Prueba','vecino',?,?,'1990-02-02')", [await clave.hashear('VecinoClaveLarga2026'), ahora]);
    vecinoId = rv.insertId;
    cookieAdmin = cookieDe(await pedir('POST', '/api/auth/entrar', { email: 'admin@x.es', clave: 'AdminClaveLarga2026' }, CSRF));
    cookieVecino = cookieDe(await pedir('POST', '/api/auth/entrar', { email: 'paco@x.es', clave: 'VecinoClaveLarga2026' }, CSRF));
    assert.ok(cookieAdmin && cookieVecino, 'sesiones de prueba');
  });
  test.after(async () => { srv.close(); await bd.cerrar(); });

  const reciboDe = async (estado) => {
    const r = await pedir('GET', `/api/admin/usuarios/${vecinoId}`, undefined, {}, cookieAdmin);
    assert.equal(r.status, 200, r.texto);
    return (r.body.usuario.recibos || []).find((x) => x.estado === estado) || null;
  };

  test('el alta en recepción deja un recibo PAGADO con tarjeta', async () => {
    const r = await pedir('POST', `/api/admin/usuarios/${vecinoId}/abono`, { meses: 1, autoRenovar: true, nfcUid: UID }, CSRF, cookieAdmin);
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.body.usuario.abono.autoRenovar, true);
    const rec = r.body.usuario.recibos;
    assert.equal(rec.length, 1);
    assert.equal(rec[0].estado, 'pagado');
    assert.equal(rec[0].metodo, 'tarjeta');
    assert.equal(rec[0].periodo, hoy().slice(0, 7));
    assert.ok(rec[0].importe > 0);
  });

  test('renovarVencidos alarga el abono caducado con auto_renovar y emite el recibo domiciliado PENDIENTE', async () => {
    const ayer = sumarDias(hoy(), -1);
    await bd.consulta('UPDATE abonos SET hasta = ? WHERE usuario_id = ?', [ayer, vecinoId]);
    const r1 = await recibos.renovarVencidos();
    assert.equal(r1.renovados, 1);
    const a = await bd.uno('SELECT hasta FROM abonos WHERE usuario_id = ?', [vecinoId]);
    assert.equal(String(a.hasta).slice(0, 10), sumarMeses(ayer, 1));
    const pendiente = await reciboDe('pendiente');
    assert.ok(pendiente, 'recibo pendiente emitido');
    assert.equal(pendiente.metodo, 'domiciliacion');
    // segunda pasada: ya no está caducado, no duplica
    assert.equal((await recibos.renovarVencidos()).renovados, 0);
  });

  test('recibo DEVUELTO: sale en /api/admin/impagos, el torno avisa dentro del plazo y la lista marca el impago', async () => {
    const pendiente = await reciboDe('pendiente');
    const r = await pedir('POST', `/api/admin/recibos/${pendiente.id}/estado`, { estado: 'devuelto' }, CSRF, cookieAdmin);
    assert.equal(r.status, 200, r.texto);
    assert.ok(r.body.usuario.abono.impago, 'el detalle del usuario trae el impago');

    const imp = await pedir('GET', '/api/admin/impagos', undefined, {}, cookieAdmin);
    assert.equal(imp.status, 200);
    assert.equal(imp.body.margenDias, 7);
    assert.equal(imp.body.impagos.length, 1);
    assert.equal(imp.body.impagos[0].nombre, 'Paco Prueba');
    assert.equal(imp.body.impagos[0].bloqueado, false);
    assert.ok(imp.body.impagos[0].venceEn > Date.now() + 6 * 86400e3);

    // El torno (Bearer) recibe el impago con su vencimiento
    const socios = await pedir('GET', '/api/torno/socios', undefined, BEARER);
    const s = socios.body.socios.find((x) => x.nfcUid === UID);
    assert.ok(s.impago && typeof s.impago.vence === 'number');

    // Dentro del plazo: entra, pero con aviso
    const v = await pedir('POST', '/api/admin/torno/validar', { lectura: UID, direccion: 'entrada' }, CSRF, cookieAdmin);
    assert.equal(v.body.resultado, 'ok');
    assert.deepEqual(v.body.avisos, ['Recibo devuelto: pendiente de pago']);

    // La lista de socios del panel marca el impago
    const lista = await pedir('GET', '/api/admin/usuarios?q=Paco', undefined, {}, cookieAdmin);
    assert.ok(lista.body.usuarios[0].abono.impago, 'impago visible en el listado');
  });

  test('con el plazo vencido (margen 0) el torno DENIEGA; el margen fuera de rango se rechaza', async () => {
    assert.equal((await pedir('PATCH', '/api/admin/ajustes/impagos', { margenDias: 200 }, CSRF, cookieAdmin)).status, 400);
    const p = await pedir('PATCH', '/api/admin/ajustes/impagos', { margenDias: 0 }, CSRF, cookieAdmin);
    assert.equal(p.status, 200, p.texto);
    const imp = await pedir('GET', '/api/admin/impagos', undefined, {}, cookieAdmin);
    assert.equal(imp.body.impagos[0].bloqueado, true);
    const v = await pedir('POST', '/api/admin/torno/validar', { lectura: UID, direccion: 'entrada' }, CSRF, cookieAdmin);
    assert.equal(v.body.resultado, 'denegado');
    assert.equal(v.body.motivo, 'Recibo devuelto sin pagar');
    // la salida siempre se permite (que nadie se quede dentro)
    const vs = await pedir('POST', '/api/admin/torno/validar', { lectura: UID, direccion: 'salida' }, CSRF, cookieAdmin);
    assert.equal(vs.body.resultado, 'ok');
  });

  test('con un recibo devuelto NO se renueva más (no se acumula deuda)', async () => {
    const ayer = sumarDias(hoy(), -1);
    await bd.consulta('UPDATE abonos SET hasta = ? WHERE usuario_id = ?', [ayer, vecinoId]);
    assert.equal((await recibos.renovarVencidos()).renovados, 0);
    const a = await bd.uno('SELECT hasta FROM abonos WHERE usuario_id = ?', [vecinoId]);
    assert.equal(String(a.hasta).slice(0, 10), ayer, 'el abono se queda caducado hasta regularizar');
    await bd.consulta('UPDATE abonos SET hasta = ? WHERE usuario_id = ?', [sumarMeses(hoy(), 1), vecinoId]);   // lo dejamos vigente para el resto
  });

  test('marcar PAGADO limpia el impago; el vecino ve sus recibos en /api/auth/yo', async () => {
    const devuelto = await reciboDe('devuelto');
    const etagAntes = (await pedir('GET', '/api/torno/socios', undefined, BEARER)).headers.etag;
    const r = await pedir('POST', `/api/admin/recibos/${devuelto.id}/estado`, { estado: 'pagado' }, CSRF, cookieAdmin);
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.body.usuario.abono.impago, undefined);
    assert.equal((await pedir('GET', '/api/admin/impagos', undefined, {}, cookieAdmin)).body.impagos.length, 0);
    const v = await pedir('POST', '/api/admin/torno/validar', { lectura: UID, direccion: 'entrada' }, CSRF, cookieAdmin);
    assert.equal(v.body.resultado, 'ok');
    assert.deepEqual(v.body.avisos, []);
    // el cambio invalida la caché del torno (ETag distinto)
    const etagDespues = (await pedir('GET', '/api/torno/socios', undefined, BEARER)).headers.etag;
    assert.notEqual(etagAntes, etagDespues);
    // el propio vecino ve sus recibos (sin datos de otros)
    const yo = await pedir('GET', '/api/auth/yo', undefined, {}, cookieVecino);
    assert.ok(Array.isArray(yo.body.usuario.recibos) && yo.body.usuario.recibos.length >= 2);
    assert.ok(yo.body.usuario.recibos.every((x) => ['pendiente', 'pagado', 'devuelto', 'anulado'].includes(x.estado)));
  });

  test('el vecino NO puede tocar recibos ni el plazo', async () => {
    const pagado = await reciboDe('pagado');
    assert.equal((await pedir('POST', `/api/admin/recibos/${pagado.id}/estado`, { estado: 'devuelto' }, CSRF, cookieVecino)).status, 403);
    assert.equal((await pedir('GET', '/api/admin/impagos', undefined, {}, cookieVecino)).status, 403);
    assert.equal((await pedir('PATCH', '/api/admin/ajustes/impagos', { margenDias: 3 }, CSRF, cookieVecino)).status, 403);
  });
}
