/* ==========================================================================
   Deportes · Medina Sidonia — código QR dinámico NUMÉRICO (módulo ÚNICO)
   Lo usan el SERVIDOR (genera el QR del carnet en /api/mi/qr) y la RASPBERRY
   del torno (valida offline, vía acceso/token.js que lo reexporta). Al ser el
   mismo fichero en el mismo repo, la paridad está garantizada bit a bit.

   Formato:  <uid><CÓDIGO(8 díg.)>
   CÓDIGO = HMAC-SHA256(seed utf8, "uid|T") → primeros 4 bytes big-endian como
            entero sin signo, módulo 10^8, rellenado a 8 dígitos.
   T      = floor(epoch_ms / 1000 / 30)  (ventana de 30 s, UTC, sin offsets).
   Validación: se aceptan T-2..T+2 (~±90 s) para absorber desfase de reloj.

   VECTOR DE PRUEBA (no cambiar nunca sin cambiar TODOS los carnets):
     codigo('1399878112', 'a1b2c3d4e5f60001', 59000000) === '71580974'
   test/token.test.js lo comprueba en cada despliegue.

   NOTA: el `uid` es solo la cadena que identifica al socio dentro del QR. Desde
   F3 es un identificador propio del carnet (qr_uid), NO el UID físico de la
   pulsera NFC (ver docs/DISENO-revisiones.md). El algoritmo no cambia.
   ========================================================================== */

'use strict';

const crypto = require('crypto');

const VENTANA = 30;      // segundos
const TOLERANCIA = 2;    // se aceptan T-2..T+2
const DIGITOS = 8;

/* Ventana temporal = epoch UTC / 30. Date.now() es UTC epoch, independiente de
   la zona horaria. NO se aplica ningún offset de zona aquí. */
function ventanaActual(msEpoch) {
  return Math.floor((msEpoch || Date.now()) / 1000 / VENTANA);
}

function codigo(uid, seed, T) {
  const mac = crypto.createHmac('sha256', Buffer.from(String(seed), 'utf8'))
    .update(String(uid) + '|' + T, 'utf8')
    .digest();
  return String(mac.readUInt32BE(0) % 100000000).padStart(DIGITOS, '0');
}

/* Un QR para el instante dado. */
function generar(uid, seed, msEpoch) {
  const T = ventanaActual(msEpoch);
  return { payload: `${uid}${codigo(uid, seed, T)}`, T };
}

/* Lote de códigos consecutivos a partir de la ventana actual (para que el
   móvil tenga QR válidos unos minutos sin cobertura). Devuelve las ventanas
   T..T+n-1 y sus códigos; el cliente elige el de la ventana en curso. */
function generarLote(uid, seed, n, msEpoch) {
  const desdeT = ventanaActual(msEpoch);
  const codigos = [];
  for (let i = 0; i < n; i++) codigos.push(codigo(uid, seed, desdeT + i));
  return { uid: String(uid), desdeT, ventanaSeg: VENTANA, codigos };
}

const esDinamico = (t) => typeof t === 'string' && /^\d+$/.test(t) && t.length >= DIGITOS + 4;

/* buscarSeed(uid) -> semilla o null. Devuelve { ok, uid, motivo } (se mantiene
   también `nfcUid` por compatibilidad con el código del torno actual). */
function validar(payload, buscarSeed, msEpoch) {
  const p = String(payload);
  if (!/^\d+$/.test(p) || p.length < DIGITOS + 4) {
    return { ok: false, uid: null, nfcUid: null, motivo: 'QR no reconocido' };
  }
  const code = p.slice(-DIGITOS);
  const uid = p.slice(0, -DIGITOS);
  const seed = buscarSeed(uid);
  if (!seed) return { ok: false, uid, nfcUid: uid, motivo: 'Carnet no reconocido' };
  const ahora = ventanaActual(msEpoch);
  for (let d = -TOLERANCIA; d <= TOLERANCIA; d++) {
    if (codigo(uid, seed, ahora + d) === code) return { ok: true, uid, nfcUid: uid, motivo: 'QR válido' };
  }
  return { ok: false, uid, nfcUid: uid, motivo: 'QR no válido o caducado' };
}

module.exports = { generar, generarLote, validar, codigo, esDinamico, ventanaActual, VENTANA, TOLERANCIA, DIGITOS };
