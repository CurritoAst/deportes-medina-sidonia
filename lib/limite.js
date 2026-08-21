/* ==========================================================================
   Deportes · Medina Sidonia — límite de peticiones (rate limit) en memoria
   Ventana deslizante por clave (p. ej. 'login:ip:1.2.3.4' o 'login:email:x').
   Vale porque Passenger corre UNA instancia; el bloqueo de CUENTA por fallos
   se guarda además en BD (usuarios.bloqueado_hasta) y sobrevive a reinicios.

   Decisiones (revisión de seguridad):
   · Límites por IP LAXOS (el pabellón entero sale por una sola IP pública) y
     control fino por email/cuenta.
   · La IP del cliente: bajo Plesk (nginx/Apache → Passenger por socket) la del
     socket es loopback; entonces se usa el ÚLTIMO valor de X-Forwarded-For.
     Si el socket NO es loopback, se ignora XFF (no es falsificable).
   · Las peticiones con Bearer válido (torno) no consumen cubo por IP.
   ========================================================================== */

'use strict';

const net = require('net');

const cubos = new Map();           // clave -> array de timestamps (ms)
const TOPE_CLAVES = 50000;

function podar(ahora) {
  if (cubos.size < TOPE_CLAVES) return;
  for (const [k, v] of cubos) { if (!v.length || v[v.length - 1] < ahora - 3600e3) cubos.delete(k); }
}
setInterval(() => podar(Date.now()), 60e3).unref();

/* Registra un intento y dice si se pasa del límite. { permitido, reintentarEn (s) } */
function intento(clave, max, ventanaMs, ahora) {
  ahora = ahora || Date.now();
  let v = cubos.get(clave);
  if (!v) { v = []; cubos.set(clave, v); }
  // descarta los que quedaron fuera de la ventana
  while (v.length && v[0] <= ahora - ventanaMs) v.shift();
  if (v.length >= max) {
    return { permitido: false, reintentarEn: Math.max(1, Math.ceil((v[0] + ventanaMs - ahora) / 1000)) };
  }
  v.push(ahora);
  return { permitido: true, reintentarEn: 0 };
}

/* Consulta sin registrar. */
function cuenta(clave, ventanaMs, ahora) {
  ahora = ahora || Date.now();
  const v = cubos.get(clave) || [];
  return v.filter((t) => t > ahora - ventanaMs).length;
}

function limpiar(clave) { cubos.delete(clave); }
function vaciarTodo() { cubos.clear(); }

const esLoopback = (ip) => !ip || ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.');

/* IP del cliente según la regla de arriba. */
function ipCliente(req) {
  const socketIp = (req.socket && req.socket.remoteAddress) || '';
  if (esLoopback(socketIp)) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const ultima = xff[xff.length - 1];
    if (ultima && net.isIP(ultima)) return ultima;
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real && net.isIP(real)) return real;
    return socketIp || '0.0.0.0';
  }
  return socketIp;
}

/* Reglas centralizadas (por IP son laxas a propósito; ver cabecera). */
const REGLAS = {
  loginIp:        { max: 100, ventanaMs: 15 * 60e3 },
  loginEmailIp:   { max: 5,   ventanaMs: 15 * 60e3 },   // por (email+ip): dispara el bloqueo de cuenta en BD
  registroIp:     { max: 30,  ventanaMs: 60 * 60e3 },
  correoEmail:    { max: 3,   ventanaMs: 60 * 60e3 },   // recuperar / reenviar verificación por email
  correoIp:       { max: 20,  ventanaMs: 60 * 60e3 },
  tokenIp:        { max: 20,  ventanaMs: 60 * 60e3 },   // verificar / restablecer
  qrSesion:       { max: 30,  ventanaMs: 60e3 },
  bearerMaloIp:   { max: 10,  ventanaMs: 60e3 },
  apiIp:          { max: 600, ventanaMs: 60e3 },
  sseIp:          { max: 5,   ventanaMs: 60e3 }
};

function comprobar(regla, clave, ahora) {
  const r = REGLAS[regla];
  if (!r) throw new Error(`regla de límite desconocida: ${regla}`);
  return intento(`${regla}:${clave}`, r.max, r.ventanaMs, ahora);
}

module.exports = { intento, cuenta, limpiar, vaciarTodo, ipCliente, comprobar, REGLAS, esLoopback };
