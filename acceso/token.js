/* ==========================================================================
   Deportes · Medina Sidonia — código QR dinámico NUMÉRICO (versión Node)
   Reimplementación EXACTA de js/token.js para el servicio de acceso.
   Formato:  <nfcUid><CÓDIGO(8 díg.)>
   CÓDIGO = HMAC-SHA256(seed, "nfcUid|T") primeros 4 bytes como entero, mod 10^8.
   Si cambias el algoritmo aquí, cámbialo también en js/token.js.
   ========================================================================== */

'use strict';

const crypto = require('crypto');

const VENTANA = 30;      // segundos
const TOLERANCIA = 2;    // se aceptan T-2..T+2 (~±90 s) para absorber desfase de reloj
const DIGITOS = 8;

/* Ventana temporal = epoch UTC / 30. Date.now() es UTC epoch, INDEPENDIENTE de
   la zona horaria: navegador y Node dan la misma T si sus relojes están en hora
   (NTP). NO se aplica ningún offset de zona aquí (eso causaría el "caducado"). */
function ventanaActual(msEpoch) {
  return Math.floor((msEpoch || Date.now()) / 1000 / VENTANA);
}

function codigo(nfcUid, seed, T) {
  const mac = crypto.createHmac('sha256', Buffer.from(seed, 'utf8'))
    .update(nfcUid + '|' + T, 'utf8')
    .digest();
  return String(mac.readUInt32BE(0) % 100000000).padStart(DIGITOS, '0');
}

function generar(nfcUid, seed, msEpoch) {
  const T = ventanaActual(msEpoch);
  return { payload: `${nfcUid}${codigo(nfcUid, seed, T)}`, T };
}

const esDinamico = (t) => typeof t === 'string' && /^\d+$/.test(t) && t.length >= DIGITOS + 4;

/* buscarSeed(uid) -> semilla o null. Devuelve { ok, nfcUid, motivo }. */
function validar(payload, buscarSeed, msEpoch) {
  const p = String(payload);
  if (!/^\d+$/.test(p) || p.length < DIGITOS + 4) {
    return { ok: false, nfcUid: null, motivo: 'QR no reconocido' };
  }
  const code = p.slice(-DIGITOS);
  const nfcUid = p.slice(0, -DIGITOS);
  const seed = buscarSeed(nfcUid);
  if (!seed) return { ok: false, nfcUid, motivo: 'Carnet no reconocido' };
  const ahora = ventanaActual(msEpoch);
  for (let d = -TOLERANCIA; d <= TOLERANCIA; d++) {
    if (codigo(nfcUid, seed, ahora + d) === code) return { ok: true, nfcUid, motivo: 'QR válido' };
  }
  return { ok: false, nfcUid, motivo: 'QR no válido o caducado' };
}

module.exports = { generar, validar, codigo, esDinamico, ventanaActual, VENTANA, TOLERANCIA, DIGITOS };
