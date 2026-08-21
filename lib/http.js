/* ==========================================================================
   Deportes · Medina Sidonia — router y middleware HTTP (Node puro)
   Una tabla de rutas { metodo, patron, acceso, esquema, maxBytes, handler } y
   un despachador que, en orden:
     1. empareja método+ruta (o 404; todo /api/* no registrado → 404);
     2. autentica según `acceso`: 'publico' | 'sesion' | ['monitor','admin'] |
        ['admin'] | 'torno' (cookie de sesión o Bearer) → 401 / 403;
     3. CSRF: TODA petición no-GET que no sea Bearer exige
        Content-Type: application/json, X-Requested-With: MSD y un Origin /
        Sec-Fetch-Site aceptable (revisión de seguridad: también sin cookie,
        para que un formulario cross-site no pueda hacer login-CSRF);
     4. lee y valida el cuerpo JSON con lib/validar.js (415/413/400);
     5. llama al handler(ctx) dentro de try/catch → 500 sin pila.
   `responder(res, codigo, obj)` siempre JSON + no-store.
   ========================================================================== */

'use strict';

const { validar } = require('./validar');

const MAX_POR_DEFECTO = 10 * 1024;

function responder(res, codigo, obj, cabeceras) {
  if (res.headersSent) return;
  const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cabeceras || {});
  res.writeHead(codigo, h);
  res.end(codigo === 204 ? undefined : JSON.stringify(obj === undefined ? {} : obj));
}
const error = (res, codigo, mensaje, extra, cabeceras) =>
  responder(res, codigo, Object.assign({ error: mensaje }, extra || {}), cabeceras);

/* Lee el cuerpo como JSON con tope de bytes. Devuelve { ok, datos } | { ok:false, codigo, error }.
   Si excede el tope, se RESPONDE 413 antes de cortar (si no, el cliente solo
   vería "connection reset") y el resultado marca `respondido:true`. */
function leerJson(req, maxBytes, res) {
  return new Promise((resolve) => {
    const tipo = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (tipo !== 'application/json') return resolve({ ok: false, codigo: 415, error: 'El cuerpo debe ser application/json.' });
    let cuerpo = '';
    let excedido = false;
    req.on('data', (t) => {
      if (excedido) return;
      cuerpo += t;
      if (cuerpo.length > (maxBytes || MAX_POR_DEFECTO)) {
        excedido = true;
        if (res) { error(res, 413, 'Cuerpo demasiado grande.', null, { Connection: 'close' }); res.on('finish', () => req.destroy()); }
        else req.destroy();
        resolve({ ok: false, codigo: 413, error: 'Cuerpo demasiado grande.', respondido: !!res });
      }
    });
    req.on('end', () => {
      if (excedido) return;
      if (!cuerpo.trim()) return resolve({ ok: true, datos: {} });
      try { resolve({ ok: true, datos: JSON.parse(cuerpo) }); }
      catch (e) { resolve({ ok: false, codigo: 400, error: 'JSON no válido.' }); }
    });
    req.on('error', () => resolve({ ok: false, codigo: 400, error: 'Error leyendo el cuerpo.' }));
  });
}

/* Origen aceptable: el de la URL pública (o localhost en desarrollo). */
function origenPermitido(req, urlPublica) {
  const permitidos = new Set();
  if (urlPublica) { try { permitidos.add(new URL(urlPublica).origin); } catch (e) { /* ignora */ } }
  const host = req.headers.host;
  if (host) { permitidos.add(`https://${host}`); permitidos.add(`http://${host}`); }
  const origen = req.headers.origin;
  const sfs = req.headers['sec-fetch-site'];
  if (sfs === 'cross-site') return false;
  if (origen) return permitidos.has(origen);
  // Sin Origin: lo aceptamos solo si el navegador declara same-origin/same-site/none
  if (sfs === 'same-origin' || sfs === 'same-site' || sfs === 'none') return true;
  // Ni Origin ni Sec-Fetch-Site: clientes no-navegador (curl) → se exige la
  // cabecera X-Requested-With (ya comprobada) y el Referer si existe.
  const ref = req.headers.referer;
  if (ref) { try { return permitidos.has(new URL(ref).origin); } catch (e) { return false; } }
  return true;
}

function crearRouter(opciones) {
  const rutas = [];
  const o = Object.assign({ urlPublica: process.env.MSD_URL_PUBLICA || '' }, opciones || {});
  // o.autenticarSesion(req,res) -> {usuario, sesion} | null ; o.autenticarTorno(req) -> {dispositivo} | null

  function ruta(metodo, patron, acceso, def) {
    const re = typeof patron === 'string' ? compilar(patron) : patron;
    rutas.push(Object.assign({ metodo, patron: re, acceso }, def));
  }
  // '/api/reservas/:id' → /^\/api\/reservas\/([^/]+)$/ con nombres
  function compilar(p) {
    const nombres = [];
    const src = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\:(\w+)|:(\w+)/g, (m, a, b) => { nombres.push(a || b); return '([^/]+)'; });
    const re = new RegExp(`^${src}$`);
    re.nombres = nombres;
    return re;
  }

  async function despachar(req, res, ruta_, ctxBase) {
    const candidatas = rutas.filter((r) => r.patron.test(ruta_));
    if (!candidatas.length) return false;                      // no es nuestra
    const r = candidatas.find((x) => x.metodo === req.method);
    if (!r) { error(res, 405, 'Método no permitido', null, { Allow: candidatas.map((x) => x.metodo).join(', ') }); return true; }

    const m = ruta_.match(r.patron);
    const params = {};
    (r.patron.nombres || []).forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    const ctx = Object.assign({ req, res, params, cuerpo: {}, sesion: null, usuario: null, torno: null }, ctxBase || {});

    try {
      // 2) autenticación / autorización
      if (r.acceso === 'torno') {
        const t = o.autenticarTorno ? await o.autenticarTorno(req) : null;
        if (!t) { error(res, 401, 'Token de dispositivo no válido', null, { 'WWW-Authenticate': 'Bearer realm="torno"' }); return true; }
        ctx.torno = t;
      } else if (r.acceso !== 'publico') {
        const s = o.autenticarSesion ? await o.autenticarSesion(req, res) : null;
        if (!s) { error(res, 401, 'Necesitas iniciar sesión', { codigo: 'SIN_SESION' }); return true; }
        ctx.sesion = s.sesion; ctx.usuario = s.usuario;
        if (Array.isArray(r.acceso) && !r.acceso.includes(s.usuario.rol)) { error(res, 403, 'Sin permiso', { codigo: 'SIN_PERMISO' }); return true; }
      } else if (o.autenticarSesion && req.method === 'GET') {
        // rutas públicas: si hay sesión la adjuntamos (p. ej. marcar 'tuya'), sin exigirla
        const s = await o.autenticarSesion(req, res).catch(() => null);
        if (s) { ctx.sesion = s.sesion; ctx.usuario = s.usuario; }
      }

      // 3) CSRF en toda petición no-GET que no sea Bearer
      if (req.method !== 'GET' && req.method !== 'HEAD' && r.acceso !== 'torno') {
        if (String(req.headers['x-requested-with'] || '') !== 'MSD') { error(res, 403, 'Petición no permitida', { codigo: 'CSRF' }); return true; }
        if (!origenPermitido(req, o.urlPublica)) { error(res, 403, 'Origen no permitido', { codigo: 'CSRF' }); return true; }
      }

      // 4) cuerpo
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
        const c = await leerJson(req, r.maxBytes, res);
        if (!c.ok) { if (!c.respondido) error(res, c.codigo, c.error); return true; }
        if (r.esquema) {
          const v = validar(r.esquema, c.datos);
          if (!v.ok) { error(res, 400, v.error, { campo: v.campo }); return true; }
          ctx.cuerpo = v.datos;
        } else {
          ctx.cuerpo = c.datos;
        }
      }

      // 5) handler
      await r.handler(ctx);
      if (!res.headersSent) error(res, 500, 'Sin respuesta');
    } catch (e) {
      console.error(`[http] ${req.method} ${ruta_}:`, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e);
      if (!res.headersSent) error(res, 500, 'Error interno');
    }
    return true;
  }

  return { ruta, despachar, rutas };
}

module.exports = { crearRouter, responder, error, leerJson, origenPermitido };
