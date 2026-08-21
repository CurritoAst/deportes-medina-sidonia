'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { crearRouter, responder } = require('../lib/http.js');

/* Servidor de prueba con un router y autenticadores simulados. */
function levantar(rutasFn, opts) {
  const router = crearRouter(Object.assign({
    urlPublica: 'http://localhost',
    autenticarSesion: async (req) => {
      const c = req.headers.cookie || '';
      if (c.includes('sid=admin')) return { sesion: { id: 's1' }, usuario: { id: 1, rol: 'admin' } };
      if (c.includes('sid=vecino')) return { sesion: { id: 's2' }, usuario: { id: 2, rol: 'vecino' } };
      return null;
    },
    autenticarTorno: async (req) => ((req.headers.authorization || '') === 'Bearer torno-ok' ? { dispositivo: 'torno' } : null)
  }, opts || {}));
  rutasFn(router);
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const ok = await router.despachar(req, res, url.pathname);
    if (!ok) { res.writeHead(404); res.end('fuera del router'); }
  });
  return new Promise((resolve) => srv.listen(0, () => resolve({ srv, puerto: srv.address().port })));
}

async function pedir(puerto, metodo, ruta, { cuerpo, headers } = {}) {
  return new Promise((resolve, reject) => {
    const datos = cuerpo === undefined ? null : (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo));
    const req = http.request({ host: '127.0.0.1', port: puerto, method: metodo, path: ruta, headers: Object.assign({}, datos ? { 'Content-Type': 'application/json' } : {}, headers || {}) }, (res) => {
      let b = ''; res.on('data', (d) => b += d); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* */ } resolve({ status: res.statusCode, headers: res.headers, body: j, texto: b }); });
    });
    req.on('error', reject);
    if (datos) req.write(datos);
    req.end();
  });
}

const CSRF = { 'X-Requested-With': 'MSD', Origin: 'http://localhost' };

test('router: 404 para /api no registrado, 405 método, params, público vs sesión vs rol vs torno', async () => {
  const { srv, puerto } = await levantar((r) => {
    r.ruta('GET', '/api/publico', 'publico', { handler: ({ res }) => responder(res, 200, { ok: 1 }) });
    r.ruta('GET', '/api/mi/:cosa', 'sesion', { handler: ({ res, params, usuario }) => responder(res, 200, { cosa: params.cosa, uid: usuario.id }) });
    r.ruta('GET', '/api/admin/x', ['admin'], { handler: ({ res }) => responder(res, 200, { admin: true }) });
    r.ruta('GET', '/api/torno/socios', 'torno', { handler: ({ res, torno }) => responder(res, 200, { d: torno.dispositivo }) });
  });
  try {
    assert.equal((await pedir(puerto, 'GET', '/api/publico')).status, 200);
    assert.equal((await pedir(puerto, 'GET', '/api/no-existe')).status, 404);
    assert.equal((await pedir(puerto, 'POST', '/api/publico', { cuerpo: {}, headers: CSRF })).status, 405);
    assert.equal((await pedir(puerto, 'GET', '/api/mi/reservas')).status, 401);
    const ok = await pedir(puerto, 'GET', '/api/mi/reservas', { headers: { Cookie: 'sid=vecino' } });
    assert.equal(ok.status, 200); assert.deepEqual(ok.body, { cosa: 'reservas', uid: 2 });
    assert.equal((await pedir(puerto, 'GET', '/api/admin/x', { headers: { Cookie: 'sid=vecino' } })).status, 403);
    assert.equal((await pedir(puerto, 'GET', '/api/admin/x', { headers: { Cookie: 'sid=admin' } })).status, 200);
    const t401 = await pedir(puerto, 'GET', '/api/torno/socios');
    assert.equal(t401.status, 401); assert.match(t401.headers['www-authenticate'], /Bearer/);
    assert.equal((await pedir(puerto, 'GET', '/api/torno/socios', { headers: { Authorization: 'Bearer torno-ok' } })).status, 200);
  } finally { srv.close(); }
});

test('CSRF: POST sin X-Requested-With → 403; con origen ajeno → 403; correcto → pasa. Bearer exento', async () => {
  const { srv, puerto } = await levantar((r) => {
    r.ruta('POST', '/api/auth/entrar', 'publico', { esquema: { email: { tipo: 'email' }, clave: { tipo: 'texto', largoMax: 128 } }, handler: ({ res, cuerpo }) => responder(res, 200, { email: cuerpo.email }) });
    r.ruta('POST', '/api/torno/acceso', 'torno', { handler: ({ res }) => responder(res, 201, { ok: true }) });
  });
  try {
    const c = { email: 'A@B.es', clave: 'x'.repeat(12) };
    assert.equal((await pedir(puerto, 'POST', '/api/auth/entrar', { cuerpo: c })).status, 403);                        // sin XRW
    assert.equal((await pedir(puerto, 'POST', '/api/auth/entrar', { cuerpo: c, headers: { 'X-Requested-With': 'MSD', Origin: 'https://malo.example' } })).status, 403);
    assert.equal((await pedir(puerto, 'POST', '/api/auth/entrar', { cuerpo: c, headers: { 'X-Requested-With': 'MSD', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const ok = await pedir(puerto, 'POST', '/api/auth/entrar', { cuerpo: c, headers: CSRF });
    assert.equal(ok.status, 200); assert.equal(ok.body.email, 'a@b.es');                                               // email normalizado
    // torno: sin cabeceras CSRF pero con Bearer → pasa
    assert.equal((await pedir(puerto, 'POST', '/api/torno/acceso', { cuerpo: {}, headers: { Authorization: 'Bearer torno-ok' } })).status, 201);
  } finally { srv.close(); }
});

test('cuerpo: 415 si no es JSON, 413 si excede, 400 si esquema falla o claves desconocidas', async () => {
  const { srv, puerto } = await levantar((r) => {
    r.ruta('POST', '/api/x', 'publico', { maxBytes: 200, esquema: { n: { tipo: 'entero', min: 1 } }, handler: ({ res, cuerpo }) => responder(res, 200, cuerpo) });
  });
  try {
    assert.equal((await pedir(puerto, 'POST', '/api/x', { cuerpo: 'n=1', headers: Object.assign({ 'Content-Type': 'text/plain' }, CSRF) })).status, 415);
    assert.equal((await pedir(puerto, 'POST', '/api/x', { cuerpo: { n: 1, relleno: 'x'.repeat(500) }, headers: CSRF })).status, 413);
    const r400 = await pedir(puerto, 'POST', '/api/x', { cuerpo: { n: 0 }, headers: CSRF });
    assert.equal(r400.status, 400); assert.equal(r400.body.campo, 'n');
    assert.equal((await pedir(puerto, 'POST', '/api/x', { cuerpo: { n: 1, extra: true }, headers: CSRF })).status, 400);
    assert.equal((await pedir(puerto, 'POST', '/api/x', { cuerpo: '{no json', headers: CSRF })).status, 400);
    assert.deepEqual((await pedir(puerto, 'POST', '/api/x', { cuerpo: { n: 7 }, headers: CSRF })).body, { n: 7 });
  } finally { srv.close(); }
});

test('un handler que lanza → 500 JSON sin pila y el servidor sigue vivo', async () => {
  const { srv, puerto } = await levantar((r) => {
    r.ruta('GET', '/api/peta', 'publico', { handler: () => { throw new Error('secreto interno'); } });
    r.ruta('GET', '/api/vivo', 'publico', { handler: ({ res }) => responder(res, 200, { vivo: true }) });
  });
  try {
    const r = await pedir(puerto, 'GET', '/api/peta');
    assert.equal(r.status, 500); assert.doesNotMatch(r.texto, /secreto interno/);
    assert.equal((await pedir(puerto, 'GET', '/api/vivo')).status, 200);
  } finally { srv.close(); }
});
