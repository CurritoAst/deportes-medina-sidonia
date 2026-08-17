/* ==========================================================================
   Deportes · Medina Sidonia — código QR dinámico NUMÉRICO (rotatorio, tipo TOTP)
   El QR contiene SOLO dígitos, para que cualquier lector del torno lo transmita
   igual que el número largo del sistema antiguo (verificado en vivo). Cambia
   cada 30 s y va firmado con un secreto por socio (HMAC-SHA256): una captura de
   pantalla deja de servir a los pocos segundos.

   Formato del contenido del QR (todo numérico):
        <nfcUid><CÓDIGO>
   donde CÓDIGO son 8 dígitos derivados de HMAC-SHA256(seed, "nfcUid|T") y
   T = floor(epochSegundos / 30). Para validar se prueban las ventanas T, T-1 y
   T+1 (margen de reloj / lag del lector). El identificador del socio va delante;
   el validador separa los 8 últimos dígitos como código.

   El MISMO algoritmo está reimplementado en Node (acceso/token.js): deben
   coincidir dígito a dígito.

   NOTA DE PROTOTIPO: la semilla viaja hoy en el registro del socio (como el
   resto del estado). En producción debería vivir solo en el servidor.
   ========================================================================== */

const MSDToken = (function () {
  'use strict';

  const VENTANA = 30;          // segundos de validez de cada código
  const TOLERANCIA = 1;        // ventanas de margen: se aceptan T, T-1 y T+1
  const DIGITOS = 8;           // longitud del código

  const enc = new TextEncoder();

  function ventanaActual(msEpoch) {
    return Math.floor((msEpoch || Date.now()) / 1000 / VENTANA);
  }

  /* Código numérico de 8 dígitos = HMAC-SHA256(seed, "uid|T"), primeros 4 bytes
     como entero, módulo 10^8. */
  async function codigo(nfcUid, seed, T) {
    if (!(window.crypto && crypto.subtle)) {
      // Alternativa sin SubtleCrypto (contextos no seguros): FNV numérico.
      let h = 0x811c9dc5 >>> 0;
      const txt = seed + '|' + nfcUid + '|' + T;
      for (let i = 0; i < txt.length; i++) h = (Math.imul(h ^ txt.charCodeAt(i), 0x01000193) >>> 0);
      return String(h % 100000000).padStart(DIGITOS, '0');
    }
    const clave = await crypto.subtle.importKey(
      'raw', enc.encode(seed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', clave, enc.encode(nfcUid + '|' + T));
    const b = new Uint8Array(mac);
    const num = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    return String(num % 100000000).padStart(DIGITOS, '0');
  }

  /* Contenido actual del QR para un socio. Incluye cuándo caduca la ventana,
     para pintar la cuenta atrás. */
  async function generar(nfcUid, seed, msEpoch) {
    const T = ventanaActual(msEpoch);
    const c = await codigo(nfcUid, seed, T);
    const restanteMs = (T + 1) * VENTANA * 1000 - (msEpoch || Date.now());
    return { payload: `${nfcUid}${c}`, T, expiraEnMs: restanteMs, ventana: VENTANA };
  }

  /* Valida un token numérico. `buscarSeed(uid)` devuelve la semilla del socio
     (o null). Devuelve { ok, nfcUid, motivo }. */
  async function validar(payload, buscarSeed, msEpoch) {
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
      if ((await codigo(nfcUid, seed, ahora + d)) === code) {
        return { ok: true, nfcUid, motivo: 'QR válido' };
      }
    }
    return { ok: false, nfcUid, motivo: 'QR no válido o caducado' };
  }

  /* ¿Tiene pinta de token dinámico? (numérico y suficientemente largo) */
  const esDinamico = (t) => typeof t === 'string' && /^\d+$/.test(t) && t.length >= DIGITOS + 4;

  return { generar, validar, codigo, esDinamico, ventanaActual, VENTANA, DIGITOS };
})();

/* Disponible también como módulo si algún día se usa con import (no rompe el
   uso global por <script> que hace la web). */
if (typeof module !== 'undefined' && module.exports) module.exports = MSDToken;
