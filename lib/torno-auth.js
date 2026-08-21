/* ==========================================================================
   Deportes · Medina Sidonia — autenticación del TORNO (token de servicio)
   La Raspberry se identifica con `Authorization: Bearer <token>`. Los tokens
   válidos vienen de la variable MSD_TOKEN_TORNO = "nombre:token[,nombre2:token2]"
   (lista para poder rotar: se añade el nuevo, se cambia la Pi, se quita el viejo).
   Comparación por SHA-256 + timingSafeEqual. Sin tabla en BD.
   Generar un token:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ========================================================================== */

'use strict';

const crypto = require('crypto');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function tokensConfigurados(valor) {
  const raw = valor !== undefined ? valor : process.env.MSD_TOKEN_TORNO;
  const lista = [];
  for (const parte of String(raw || '').split(',')) {
    const p = parte.trim();
    if (!p) continue;
    const i = p.indexOf(':');
    const nombre = i > 0 ? p.slice(0, i).trim() : 'torno';
    const token = i > 0 ? p.slice(i + 1).trim() : p;
    if (token.length >= 32) lista.push({ nombre, hash: sha(token) });
  }
  return lista;
}

/* Estado en memoria del torno (última señal de vida), para /api/admin/torno/estado. */
const estado = { nombre: null, ultimoContacto: null, ip: null, version: null, desfaseMs: null };

/* Devuelve { dispositivo } si el Bearer es válido, o null. */
function autenticar(req, tokens) {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) return null;
  const presentado = auth.slice(7).trim();
  if (presentado.length < 32 || presentado.length > 256) return null;
  const h = sha(presentado);
  for (const t of (tokens || tokensConfigurados())) {
    if (t.hash.length === h.length && crypto.timingSafeEqual(t.hash, h)) {
      estado.nombre = t.nombre;
      estado.ultimoContacto = Date.now();
      const v = String(req.headers['x-torno-version'] || '').slice(0, 40);
      if (v) estado.version = v;
      return { dispositivo: t.nombre };
    }
  }
  return null;
}

const configurado = () => tokensConfigurados().length > 0;

module.exports = { autenticar, tokensConfigurados, configurado, estado };
