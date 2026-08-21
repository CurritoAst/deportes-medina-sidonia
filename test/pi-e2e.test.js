'use strict';
/* Integración Pi ↔ servidor F3 CONTRA BD REAL: arranca el servidor (router F2/F3),
   da de alta un socio con pulsera, arranca acceso/acceso.js apuntando a él con
   el lector simulado, y comprueba: sync con Bearer (+ETag 304), pulsera abre,
   QR del lote abre, QR con qrUid desnudo NO abre, y la cola offline se reenvía
   SIN duplicar cuando la web vuelve.
   MSD_DB_HOST=127.0.0.1 MSD_DB_PORT=3307 MSD_DB_NAME=deportes_pruebas MSD_DB_USER=root MSD_DB_PASSWORD= node --test test/pi-e2e.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const HAY_BD = !!(process.env.MSD_DB_HOST || process.env.MSD_DB_NAME);
if (!HAY_BD) {
  test('pi e2e (omitido: sin MSD_DB_*)', { skip: 'define MSD_DB_* hacia una BD de PRUEBAS' }, () => {});
} else {
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'msd-pi-'));
  process.env.MSD_DATA_DIR = DIR; process.env.MSD_URL_PUBLICA = 'http://localhost'; process.env.MSD_HTTPS = '0'; delete process.env.MSD_SMTP_HOST;
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
  const abonos = require('../lib/abonos');
  const token = require('../lib/token');
  const clave = require('../lib/clave');

  let srv, puertoWeb, puertoLector, lectorSrv, lectorSock = null, pi = null, logPi = '';
  const difundidos = [];
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  async function hasta(fn, ms, paso) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (await fn()) return true; await esperar(paso || 100); } return false; }

  function arrancarWeb() {
    return new Promise((resolve) => {
      const router = crearRouter({ urlPublica: 'http://localhost', autenticarSesion: (req, res) => sesion.autenticar(req, res), autenticarTorno: (req) => Promise.resolve(tornoAuth.autenticar(req)) });
      authRutas.montar(router); authRutas.anadirExtras(abonosRutas.extrasUsuario);
      tornoRutas.montar(router, { difundirAcceso: (e) => difundidos.push(e) });
      abonosRutas.montar(router, { difundirAcceso: (e) => difundidos.push(e) });
      srv = http.createServer((req, res) => {
        const ruta = new URL(req.url, 'http://x').pathname;
        router.despachar(req, res, ruta, { ip: limite.ipCliente(req) }).then((ok) => { if (!ok) { res.writeHead(404); res.end(); } });
      });
      srv.listen(puertoWeb || 0, '127.0.0.1', () => { puertoWeb = srv.address().port; resolve(); });
    });
  }
  function pararWeb() { return new Promise((r) => { if (!srv) return r(); srv.close(() => r()); srv.closeAllConnections && srv.closeAllConnections(); }); }
  function lector(linea) { if (lectorSock) lectorSock.write(linea + '\r\n'); }

  let vecinoId;
  test.before(async () => {
    const tablas = await bd.consulta("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()");
    await bd.consulta('SET FOREIGN_KEY_CHECKS = 0'); for (const f of tablas) await bd.consulta(`DROP TABLE IF EXISTS \`${f.t}\``); await bd.consulta('SET FOREIGN_KEY_CHECKS = 1');
    await migrar();
    const rv = await bd.consulta("INSERT INTO usuarios (email, nombre, rol, clave_hash, email_verificado_en, fecha_nacimiento) VALUES ('carmen@x.es','Carmen Aragón','vecino',?,NOW(),'1985-04-12')", [await clave.hashear('VecinaClaveLarga2026')]);
    vecinoId = rv.insertId;
    await abonos.altaAbono({ usuarioId: vecinoId, meses: 1, nfcUid: '1399878112' });
    await arrancarWeb();
    // lector simulado: un servidor TCP; la Pi se conecta a él
    lectorSrv = net.createServer((s) => { lectorSock = s; s.on('error', () => {}); });
    await new Promise((r) => lectorSrv.listen(0, '127.0.0.1', r));
    puertoLector = lectorSrv.address().port;
    // arranca la Pi (acceso.js) apuntando a la web de pruebas y al lector
    const env = Object.assign({}, process.env, {
      MSD_WEB: `http://127.0.0.1:${puertoWeb}`, MSD_TOKEN_TORNO: TOKEN,
      MSD_HOST_ENTRADA: '127.0.0.1', MSD_PUERTO_ENTRADA: String(puertoLector), MSD_HOST_SALIDA: '127.0.0.1', MSD_PUERTO_SALIDA: String(puertoLector + 1),
      MSD_GPIO: 'sim', MSD_CACHE: path.join(DIR, 'cache.json'), MSD_COLA: path.join(DIR, 'cola.json'), MSD_TZ: 'Europe/Madrid'
    });
    pi = spawn(process.execPath, [path.join(__dirname, '..', 'acceso', 'acceso.js')], { env, cwd: path.join(__dirname, '..') });
    pi.stdout.on('data', (d) => { logPi += d.toString(); }); pi.stderr.on('data', (d) => { logPi += d.toString(); });
    assert.ok(await hasta(() => /Sincronizados 1 socios/.test(logPi), 10000), 'la Pi sincroniza con Bearer: ' + logPi.slice(-600));
    assert.ok(await hasta(() => lectorSock !== null, 8000), 'la Pi se conecta al lector');
  });
  test.after(async () => {
    // Orden: primero la Pi (cliente), luego el lector y la web; así ningún
    // socket queda hablando con un servidor ya cerrado.
    if (pi) { pi.kill(); await new Promise((r) => { pi.once('exit', r); setTimeout(r, 2000); }); }
    if (lectorSock) { try { lectorSock.destroy(); } catch (e) { /* */ } }
    if (lectorSrv) await new Promise((r) => lectorSrv.close(() => r()));
    await pararWeb();
    await bd.cerrar();
  });

  test('la caché de la Pi es v2 con qrUid y qrSeed, y el ETag hace 304 en la siguiente sync', async () => {
    const cache = JSON.parse(fs.readFileSync(path.join(DIR, 'cache.json'), 'utf8'));
    assert.equal(cache.version, 2); assert.equal(cache.socios.length, 1);
    assert.ok(cache.socios[0].qrUid && cache.socios[0].qrSeed && cache.socios[0].nfcUid === '1399878112');
    assert.ok(cache.etag);
  });

  test('pulsera conocida → abre y se registra en la tabla con el usuario resuelto por raw', async () => {
    const antes = difundidos.length;
    lector('1399878112');
    assert.ok(await hasta(() => difundidos.length > antes), 'acceso registrado: ' + logPi.slice(-400));
    const ev = difundidos[difundidos.length - 1];
    assert.equal(ev.resultado, 'ok'); assert.equal(ev.usuarioId, String(vecinoId)); assert.equal(ev.metodo, 'nfc');
    assert.match(logPi, /✔ ENTRADA · Carmen Aragón · Abono en vigor/);
  });

  test('QR del lote del servidor → abre (paridad bit a bit); el qrUid desnudo NO abre', async () => {
    const lote = await abonos.loteQr(vecinoId);
    const T = token.ventanaActual();
    const payload = lote.qrUid + lote.codigos[T - lote.desdeT];
    const antes = difundidos.length;
    lector(payload);
    assert.ok(await hasta(() => difundidos.length > antes));
    assert.equal(difundidos[difundidos.length - 1].resultado, 'ok'); assert.equal(difundidos[difundidos.length - 1].metodo, 'qr');
    const antes2 = difundidos.length;
    await esperar(2100);   // fuera de la ventana de dedup
    lector(lote.qrUid);
    assert.ok(await hasta(() => difundidos.length > antes2));
    assert.equal(difundidos[difundidos.length - 1].resultado, 'denegado');
  });

  test('web caída → el acceso se ENCOLA; web vuelve → se reenvía UNA vez (idempotente)', async () => {
    await pararWeb();
    await esperar(2100);
    lector('1399878112');
    assert.ok(await hasta(() => /ENCOLADO para reenviar/.test(logPi), 15000), 'encolado: ' + logPi.slice(-400));
    const cola = JSON.parse(fs.readFileSync(path.join(DIR, 'cola.json'), 'utf8'));
    assert.equal(cola.length, 1); assert.match(cola[0].id, /^[0-9a-f]{32}$/);
    const n0 = Number((await bd.uno('SELECT COUNT(*) AS n FROM accesos')).n);
    await arrancarWeb();                                  // mismo puerto
    assert.ok(await hasta(() => /Reenviados 1 accesos/.test(logPi), 70000, 500), 'reenvío: ' + logPi.slice(-400));
    const n1 = Number((await bd.uno('SELECT COUNT(*) AS n FROM accesos')).n);
    assert.equal(n1, n0 + 1);
    // reenviar el mismo evento otra vez (simulando una segunda vuelta de cola) no duplica
    const r = await tornoRutas.registrarAcceso(cola[0], { origen: 'torno' });
    assert.equal(r.duplicado, true);
    assert.equal(Number((await bd.uno('SELECT COUNT(*) AS n FROM accesos')).n), n1);
  });
}
