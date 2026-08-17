/* ==========================================================================
   Deportes · Medina Sidonia — código QR dinámico (rotatorio, tipo TOTP)
   Sustituye al QR estático clonable. El código cambia cada 30 s y va firmado
   con un secreto por socio (HMAC-SHA256), así una captura de pantalla deja de
   servir a los pocos segundos.

   Formato del contenido del QR:
        MSD2|<nfcUid>|<T>|<FIRMA>
   donde:
     - nfcUid : identificador del socio (mismo que la pulsera/tarjeta).
     - T      : ventana temporal = floor(epochSegundos / 30).
     - FIRMA  : primeros 4 bytes de HMAC-SHA256(seed, "nfcUid|T") en HEX (8 car.).

   El MISMO algoritmo está reimplementado en Node para el servicio de acceso
   (acceso/token.js). Si tocas uno, toca el otro: deben coincidir byte a byte.

   NOTA DE PROTOTIPO: aquí la semilla (seed) viaja en el registro del socio,
   que hoy se descarga entera al navegador (igual que los hash de contraseña).
   En producción la semilla debe vivir SOLO en el servidor y el código lo
   generaría/validaría el backend con sesión de servidor. Aun así, el código
   rotatorio ya derrota al robo por captura/foto de pantalla, que es el fallo
   real del sistema estático actual.
   ========================================================================== */

const MSDToken = (function () {
  'use strict';

  const VENTANA = 30;          // segundos de validez de cada código
  const TOLERANCIA = 1;        // ventanas de margen (reloj/lag del lector): ±1

  const enc = new TextEncoder();

  function ventanaActual(msEpoch) {
    return Math.floor((msEpoch || Date.now()) / 1000 / VENTANA);
  }

  function hexDe(buffer, nBytes) {
    const vista = new Uint8Array(buffer).slice(0, nBytes);
    let s = '';
    for (const b of vista) s += b.toString(16).padStart(2, '0');
    return s.toUpperCase();
  }

  /* Firma HMAC-SHA256 de "uid|T" con la semilla. Devuelve 8 caracteres HEX. */
  async function firma(nfcUid, seed, T) {
    if (!(window.crypto && crypto.subtle)) {
      // Alternativa sin SubtleCrypto (contextos no seguros): FNV con la semilla.
      let h = 0x811c9dc5;
      const txt = seed + '|' + nfcUid + '|' + T;
      for (let i = 0; i < txt.length; i++) h = Math.imul(h ^ txt.charCodeAt(i), 0x01000193) >>> 0;
      return h.toString(16).padStart(8, '0').toUpperCase();
    }
    const clave = await crypto.subtle.importKey(
      'raw', enc.encode(seed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', clave, enc.encode(nfcUid + '|' + T));
    return hexDe(mac, 4);
  }

  /* Contenido actual del QR para un socio. Incluye cuándo caduca la ventana,
     para pintar la cuenta atrás. */
  async function generar(nfcUid, seed, msEpoch) {
    const T = ventanaActual(msEpoch);
    const f = await firma(nfcUid, seed, T);
    const restanteMs = (T + 1) * VENTANA * 1000 - (msEpoch || Date.now());
    return { payload: `MSD2|${nfcUid}|${T}|${f}`, T, expiraEnMs: restanteMs, ventana: VENTANA };
  }

  /* ¿Es este texto un token dinámico nuestro? */
  const esDinamico = (texto) => typeof texto === 'string' && texto.startsWith('MSD2|');

  /* Valida un token. `buscarSeed(uid)` devuelve la semilla del socio (o null).
     Devuelve { ok, nfcUid, T, motivo }. */
  async function validar(payload, buscarSeed, msEpoch) {
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
    const esperado = await firma(nfcUid, seed, T);
    if (esperado !== code) return { ok: false, nfcUid, T, motivo: 'Firma del QR no válida' };
    return { ok: true, nfcUid, T, motivo: 'QR válido' };
  }

  return { generar, validar, esDinamico, ventanaActual, VENTANA };
})();

/* Disponible también como módulo si algún día se usa con import (no rompe el
   uso global por <script> que hace la web). */
if (typeof module !== 'undefined' && module.exports) module.exports = MSDToken;
