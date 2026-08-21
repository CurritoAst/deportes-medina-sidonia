/* ==========================================================================
   Deportes · Medina Sidonia — rutas del TORNO (Bearer) y registro de accesos
     GET  /api/torno/ping     → {ok, ahora}            (mide desfase de reloj)
     GET  /api/torno/socios   → {version:2, generado, socios:[…]} con ETag/304
                                (ÚNICO endpoint que entrega qrSeed)
     POST /api/torno/acceso   → guarda un acceso; idempotente por evento_uid
   Además `registrarAcceso()` lo usa el POST /api/acceso legado (sin token)
   mientras la Pi no se actualice, y el validador del panel.
   El servidor NO se fía del usuarioId que manda la Pi: re-resuelve por `raw`
   (nfc_uid, nfc_id_legacy o prefijo qr_uid del payload) y deja NULL si no casa.
   ========================================================================== */

'use strict';

const bd = require('./bd');
const { responder, error } = require('./http');
const abonos = require('./abonos');
const token = require('./token');
const tornoAuth = require('./torno-auth');

const UID_RE = /^\d{6,20}$/;

/* Resuelve el usuario a partir de lo leído por el lector. */
async function resolverUsuarioPorRaw(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  if (token.esDinamico(v)) {
    const qrUid = v.slice(0, -token.DIGITOS);
    const f = await bd.uno('SELECT usuario_id FROM carnets WHERE qr_uid = ?', [qrUid]);
    if (f) return f.usuario_id;
  }
  if (UID_RE.test(v) || /^NFC-[A-Z0-9]{8}$/.test(v)) {
    const f = await bd.uno('SELECT usuario_id FROM carnets WHERE nfc_uid = ? OR nfc_id_legacy = ?', [v, v]);
    if (f) return f.usuario_id;
  }
  return null;
}

/* Valida la forma del evento (mismo contrato que el legado + id/avisos). */
function saneaEvento(e) {
  if (!e || typeof e !== 'object') return null;
  if (!['qr', 'nfc'].includes(e.metodo) || !['ok', 'denegado'].includes(e.resultado) || !['entrada', 'salida'].includes(e.direccion)) return null;
  if (typeof e.motivo !== 'string' || e.motivo.length > 120) return null;
  const ts = (typeof e.ts === 'number' && e.ts > 0) ? e.ts : Date.now();
  const avisos = Array.isArray(e.avisos) ? e.avisos.filter((a) => typeof a === 'string').slice(0, 5).map((a) => a.slice(0, 80)) : [];
  const id = (typeof e.id === 'string' && /^[0-9a-f]{32}$/i.test(e.id.replace(/-/g, ''))) ? e.id.replace(/-/g, '').toLowerCase() : null;
  return { id, ts, metodo: e.metodo, resultado: e.resultado, direccion: e.direccion, motivo: e.motivo, raw: typeof e.raw === 'string' ? e.raw.slice(0, 64) : '', avisos };
}

/* Guarda el acceso en la tabla `accesos`. Devuelve { evento, duplicado }. */
async function registrarAcceso(e, { origen, dispositivo } = {}) {
  const ev = saneaEvento(e);
  if (!ev) return { error: 'evento inválido' };
  // ts: si es absurdo (reloj de la Pi loco) se usa el del servidor, nunca 4xx
  const ahora = Date.now();
  const ts = (ev.ts > ahora + 5 * 60e3 || ev.ts < ahora - 60 * 86400e3) ? ahora : ev.ts;
  const usuarioId = await resolverUsuarioPorRaw(ev.raw);
  try {
    const r = await bd.consulta(
      'INSERT INTO accesos (ts, usuario_id, metodo, resultado, motivo, direccion, raw, avisos, origen, dispositivo, evento_uid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [new Date(ts), usuarioId, ev.metodo, ev.resultado, ev.motivo, ev.direccion, ev.raw, JSON.stringify(ev.avisos), origen || 'torno', String(dispositivo || '').slice(0, 40), ev.id]);
    const nombre = usuarioId ? (await bd.uno('SELECT nombre FROM usuarios WHERE id = ?', [usuarioId]) || {}).nombre : null;
    return { evento: { id: r.insertId, ts, usuarioId: usuarioId ? String(usuarioId) : null, nombre: nombre || null, metodo: ev.metodo, resultado: ev.resultado, motivo: ev.motivo, direccion: ev.direccion, raw: ev.raw, avisos: ev.avisos }, duplicado: false };
  } catch (err) {
    if (bd.esDuplicado(err) && ev.id) return { evento: { id: null, ts, usuarioId: usuarioId ? String(usuarioId) : null, metodo: ev.metodo, resultado: ev.resultado, motivo: ev.motivo, direccion: ev.direccion, raw: ev.raw, avisos: ev.avisos }, duplicado: true };
    throw err;
  }
}

/* Rango UTC [inicio, fin) del día de Europe/Madrid en curso. Se calcula en
   Node (no con CONVERT_TZ: muchas MariaDB no tienen cargadas las zonas). */
function rangoHoyMadrid() {
  const { hoy, claveDia } = require('./fechas');
  const dia = hoy();
  // Buscamos el instante UTC en que empieza ese día en Madrid: probamos la
  // medianoche UTC y corregimos por el offset real (1 o 2 h) mirando claveDia.
  const base = Date.parse(dia + 'T00:00:00Z');
  let inicio = base - 3 * 3600e3;            // ≥ 3 h antes seguro que aún es el día anterior en Madrid
  while (claveDia(new Date(inicio)) !== dia) inicio += 60e3;   // avanza por minutos hasta entrar en el día (máx. ~180 iteraciones)
  let fin = inicio + 24 * 3600e3;
  while (claveDia(new Date(fin - 1)) !== dia) fin -= 60e3;     // ajusta por cambio de hora (23/25 h)
  while (claveDia(new Date(fin)) === dia) fin += 60e3;
  return { inicio: new Date(inicio), fin: new Date(fin), dia };
}

/* Aforo del día (Madrid) desde la tabla. */
async function aforoHoy() {
  const { inicio, fin } = rangoHoyMadrid();
  const f = await bd.uno(
    `SELECT SUM(direccion = 'entrada') AS entradas, SUM(direccion = 'salida') AS salidas
       FROM accesos WHERE resultado = 'ok' AND ts >= ? AND ts < ?`, [inicio, fin]).catch(() => null);
  const entradas = Number(f && f.entradas) || 0, salidas = Number(f && f.salidas) || 0;
  const aforoMax = Number(await abonos.ajuste('aforo_max', 40)) || 40;
  return { entradas, salidas, dentro: Math.max(0, entradas - salidas), aforoMax };
}

function montar(router, { difundirAcceso } = {}) {
  router.ruta('GET', '/api/torno/ping', 'torno', { handler: ({ res }) => responder(res, 200, { ok: true, ahora: Date.now() }) });

  router.ruta('GET', '/api/torno/socios', 'torno', { handler: async (ctx) => {
    const etag = await abonos.etagTorno();
    const recibido = String(ctx.req.headers['if-none-match'] || '').replace(/^W\//, '').replace(/-gzip"$/, '"');
    if (recibido && recibido === etag) { ctx.res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-store' }); ctx.res.end(); return; }
    const socios = await abonos.sociosParaTorno();
    responder(ctx.res, 200, { version: 2, generado: Date.now(), socios }, { ETag: etag });
  } });

  router.ruta('POST', '/api/torno/acceso', 'torno', { maxBytes: 8 * 1024, handler: async (ctx) => {
    const r = await registrarAcceso(ctx.cuerpo && ctx.cuerpo.evento, { origen: 'torno', dispositivo: ctx.torno.dispositivo });
    if (r.error) return error(ctx.res, 400, r.error);
    if (!r.duplicado && difundirAcceso) difundirAcceso(r.evento);
    responder(ctx.res, r.duplicado ? 200 : 201, { ok: true, duplicado: r.duplicado, evento: r.evento });
  } });
}

module.exports = { montar, registrarAcceso, resolverUsuarioPorRaw, saneaEvento, aforoHoy, rangoHoyMadrid };
