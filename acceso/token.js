/* ==========================================================================
   Deportes · Medina Sidonia — código QR dinámico (versión Node)
   Reimplementación EXACTA de js/token.js para el servicio de acceso.
   Formato:  MSD2|<nfcUid>|<T>|<FIRMA>
   FIRMA = primeros 4 bytes de HMAC-SHA256(seed, "nfcUid|T") en HEX (8 car.).
   Si cambias el algoritmo aquí, cámbialo también en js/token.js.
   ========================================================================== */

'use strict';

const crypto = require('crypto');

const VENTANA = 30;      // segundos
const TOLERANCIA = 1;    // ±1 ventana de margen

function ventanaActual(msEpoch) {
  return Math.floor((msEpoch || Date.now()) / 1000 / VENTANA);
}

function firma(nfcUid, seed, T) {
  const mac = crypto.createHmac('sha256', Buffer.from(seed, 'utf8'))
    .update(nfcUid + '|' + T, 'utf8')
    .digest();
  return mac.slice(0, 4).toString('hex').toUpperCase();
}

function generar(nfcUid, seed, msEpoch) {
  const T = ventanaActual(msEpoch);
  return { payload: `MSD2|${nfcUid}|${T}|${firma(nfcUid, seed, T)}`, T };
}

const esDinamico = (texto) => typeof texto === 'string' && texto.startsWith('MSD2|');

/* buscarSeed(uid) -> semilla o null. Devuelve { ok, nfcUid, T, motivo }. */
function validar(payload, buscarSeed, msEpoch) {
  const partes = String(payload).split('|');
  if (partes.length !== 4 || partes[0] !== 'MSD2') {
    return { ok: false, nfcUid: null, motivo: 'QR no reconocido' };
  }
  const nfcUid = partes[1];
  const T = Number(partes[2]);
  const code = partes[3];
  if (!/^\d+$/.test(partes[2]) || !/^[0-9A-F]{8}$/.test(code)) {
    return { ok: false, nfcUid, motivo: 'QR con formato inválido' };
  }
  const ahora = ventanaActual(msEpoch);
  if (Math.abs(ahora - T) > TOLERANCIA) {
    return { ok: false, nfcUid, T, motivo: 'QR caducado (código antiguo)' };
  }
  const seed = buscarSeed(nfcUid);
  if (!seed) return { ok: false, nfcUid, T, motivo: 'Carnet no reconocido' };
  if (firma(nfcUid, seed, T) !== code) {
    return { ok: false, nfcUid, T, motivo: 'Firma del QR no válida' };
  }
  return { ok: true, nfcUid, T, motivo: 'QR válido' };
}

module.exports = { generar, validar, firma, esDinamico, ventanaActual, VENTANA, TOLERANCIA };
