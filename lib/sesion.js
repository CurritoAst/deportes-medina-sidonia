/* ==========================================================================
   Deportes · Medina Sidonia — sesiones en servidor (cookie + tabla `sesiones`)
   · Id de sesión = 32 bytes aleatorios (base64url) que viaja SOLO en la cookie.
     En BD se guarda su SHA-256: una copia de la tabla no sirve para suplantar.
   · Cookie `__Host-msd_sid` (HTTPS): HttpOnly, Secure, SameSite=Lax, Path=/.
     En desarrollo http se llama `msd_sid` y no lleva Secure (se avisa por log).
   · Caducidad: vecino 14 d inactividad / 30 d absoluto; monitor y admin
     12 h / 7 d. `ultimo_uso_en` se actualiza como mucho cada 5 min.
   · El rol se lee SIEMPRE de `usuarios` en cada petición (un cambio de rol o
     una baja se aplican al instante). Login = sesión nueva (rotación).
   ========================================================================== */

'use strict';

const crypto = require('crypto');
const bd = require('./bd');

const NOMBRE_SEGURO = '__Host-msd_sid';
const NOMBRE_DEV = 'msd_sid';
const ACTUALIZAR_USO_MS = 5 * 60e3;

const DURACION = {
  vecino:  { inactividad: 14 * 86400e3, absoluto: 30 * 86400e3 },
  monitor: { inactividad: 12 * 3600e3,  absoluto: 7 * 86400e3 },
  admin:   { inactividad: 12 * 3600e3,  absoluto: 7 * 86400e3 }
};

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* ¿La petición llegó por HTTPS? (Plesk pone x-forwarded-proto; MSD_HTTPS fuerza). */
function esHttps(req) {
  if (process.env.MSD_HTTPS === '1') return true;
  if (process.env.MSD_HTTPS === '0') return false;
  const xfp = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (xfp) return xfp === 'https';
  return !!(req.socket && req.socket.encrypted);
}
const nombreCookie = (req) => (esHttps(req) ? NOMBRE_SEGURO : NOMBRE_DEV);

function leerCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const parte of raw.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    const k = parte.slice(0, i).trim();
    const v = parte.slice(i + 1).trim();
    if (k && !(k in out)) out[k] = decodeURIComponent(v);
  }
  return out;
}

function cabeceraCookie(req, valor, maxAgeSeg) {
  const https = esHttps(req);
  const nombre = https ? NOMBRE_SEGURO : NOMBRE_DEV;
  const partes = [`${nombre}=${valor}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeg}`];
  if (https) partes.push('Secure');
  return partes.join('; ');
}

function anadirSetCookie(res, valor) {
  const previas = res.getHeader('Set-Cookie');
  const lista = Array.isArray(previas) ? previas.slice() : (previas ? [previas] : []);
  lista.push(valor);
  res.setHeader('Set-Cookie', lista);
}

/* Crea una sesión para el usuario y fija la cookie. Devuelve el id (no el hash). */
async function crear(req, res, usuario, meta) {
  const dur = DURACION[usuario.rol] || DURACION.vecino;
  const id = crypto.randomBytes(32).toString('base64url');
  const ahora = new Date();
  const expira = new Date(ahora.getTime() + Math.min(dur.inactividad, dur.absoluto));
  await bd.consulta(
    'INSERT INTO sesiones (id, usuario_id, creada_en, ultimo_uso_en, expira_en, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [sha256(id), usuario.id, ahora, ahora, expira, (meta && meta.ip) || null, String((meta && meta.userAgent) || '').slice(0, 255) || null]
  );
  anadirSetCookie(res, cabeceraCookie(req, id, Math.floor(dur.absoluto / 1000)));
  if (!esHttps(req) && !global.__msdAvisoHttp) { global.__msdAvisoHttp = true; console.warn('[sesion] Aviso: cookie sin Secure (desarrollo http). En producción debe ir por HTTPS.'); }
  return id;
}

/* Lee la cookie, comprueba la sesión y devuelve { sesion, usuario } o null.
   `usuario` trae lo justo para autorizar (sin hash): id, nombre, email, rol,
   email_verificado_en, debe_cambiar_clave, eliminado_en. */
async function autenticar(req, res) {
  const cookies = leerCookies(req);
  const id = cookies[NOMBRE_SEGURO] || cookies[NOMBRE_DEV];
  if (!id || id.length < 20 || id.length > 128) return null;
  const hash = sha256(id);
  const ahora = new Date();
  const fila = await bd.uno(
    `SELECT s.id AS sid, s.usuario_id, s.creada_en, s.ultimo_uso_en, s.expira_en,
            u.id, u.nombre, u.email, u.rol, u.telefono, u.fecha_nacimiento, u.email_verificado_en, u.debe_cambiar_clave, u.eliminado_en
       FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.id = ? AND s.expira_en > ?`, [hash, ahora]);
  if (!fila) return null;
  if (fila.eliminado_en) { await bd.consulta('DELETE FROM sesiones WHERE id = ?', [hash]); return null; }
  // tope absoluto por rol (por si cambió el rol a uno más estricto)
  const dur = DURACION[fila.rol] || DURACION.vecino;
  if (ahora - new Date(fila.creada_en) > dur.absoluto) { await bd.consulta('DELETE FROM sesiones WHERE id = ?', [hash]); return null; }
  // renovación deslizante, como mucho cada 5 min
  if (ahora - new Date(fila.ultimo_uso_en) > ACTUALIZAR_USO_MS) {
    const nuevaExp = new Date(Math.min(ahora.getTime() + dur.inactividad, new Date(fila.creada_en).getTime() + dur.absoluto));
    bd.consulta('UPDATE sesiones SET ultimo_uso_en = ?, expira_en = ? WHERE id = ?', [ahora, nuevaExp, hash]).catch(() => {});
  }
  return {
    sesion: { hash, id: fila.sid, creadaEn: fila.creada_en },
    usuario: {
      id: fila.id, nombre: fila.nombre, email: fila.email, rol: fila.rol, telefono: fila.telefono,
      fechaNacimiento: fila.fecha_nacimiento || null, verificado: !!fila.email_verificado_en,
      debeCambiarClave: !!fila.debe_cambiar_clave
    }
  };
}

/* Cierra la sesión actual (borra en BD y caduca la cookie). */
async function cerrar(req, res, sesion) {
  if (sesion && sesion.hash) await bd.consulta('DELETE FROM sesiones WHERE id = ?', [sesion.hash]);
  anadirSetCookie(res, cabeceraCookie(req, '', 0));
}

/* Revoca TODAS las sesiones de un usuario (cambio de clave/rol, baja…),
   opcionalmente conservando una (la actual). */
async function revocarTodas(usuarioId, conservarHash) {
  if (conservarHash) return bd.consulta('DELETE FROM sesiones WHERE usuario_id = ? AND id <> ?', [usuarioId, conservarHash]);
  return bd.consulta('DELETE FROM sesiones WHERE usuario_id = ?', [usuarioId]);
}

/* Purga de caducadas (tarea periódica). */
async function purgar() {
  const r = await bd.consulta('DELETE FROM sesiones WHERE expira_en <= ?', [new Date()]);
  return r && r.affectedRows ? r.affectedRows : 0;
}

module.exports = { crear, autenticar, cerrar, revocarTodas, purgar, leerCookies, esHttps, nombreCookie, sha256, DURACION };
