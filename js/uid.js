/* ==========================================================================
   Deportes · Medina Sidonia — normalización del UID de pulseras/tarjetas NFC
   Módulo ÚNICO para navegador (panel) y servidor (lib/uid.js lo reexporta).

   El torno (lector HM20 por RS-485) entrega el UID Mifare como número DECIMAL
   (p. ej. "1399878112"). Los lectores de escritorio USB "tipo teclado"
   (ACR122U, lectores chinos de 125 kHz/13,56 MHz) escriben ese mismo UID de
   formas distintas: decimal, hexadecimal ("53E2B8A1"), con separadores
   ("53:E2:B8:A1"), con ceros delante ("0053E2B8A1"), o con los bytes en orden
   inverso. Para que una pulsera dada de alta en recepción con un lector USB
   ABRA el torno, aquí se convierte TODO al decimal que verá el torno.

   Como no se puede saber a ciegas el orden de bytes del lector USB, se
   devuelven TODAS las interpretaciones razonables; el panel guarda la
   "principal" y muestra las alternativas; el servidor comprueba el choque de
   UNIQUE contra todas (para avisar si otra lectura de la misma pulsera ya
   existe en otro orden).
   ========================================================================== */

const MSDUid = (function () {
  'use strict';

  const limpiar = (s) => String(s || '').trim();

  /* BigInt desde bytes (big-endian). */
  function desdeBytes(bytes) {
    let n = 0n;
    for (const b of bytes) n = (n << 8n) + BigInt(b);
    return n;
  }
  function bytesDesdeHex(hex) {
    const h = hex.length % 2 ? '0' + hex : hex;
    const out = [];
    for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
    return out;
  }
  function aBytes(n, minLen) {
    const out = [];
    let x = BigInt(n);
    while (x > 0n) { out.unshift(Number(x & 0xFFn)); x >>= 8n; }
    while (out.length < (minLen || 0)) out.unshift(0);
    return out;
  }
  const esDecimal = (s) => /^\d{6,20}$/.test(s);
  const esHex = (s) => /^[0-9a-fA-F]{6,16}$/.test(s) && !/^\d+$/.test(s);   // si es todo dígitos, se trata como decimal

  /* Normaliza una lectura. Devuelve:
       { ok:true, principal:'<decimal>', formato:'decimal'|'hex', alternativas:['<decimal>'...], aviso? }
     o { ok:false, error }.
     - Decimal → principal = tal cual (sin ceros a la izquierda salvo que sea todo ceros).
     - Hex → principal = decimal big-endian; alternativa = decimal little-endian
       (bytes invertidos), que es lo que escriben bastantes lectores USB. */
  function normalizar(entrada) {
    let s = limpiar(entrada).replace(/^(0x|0X)/, '').replace(/[\s:\-.]/g, '');
    if (!s) return { ok: false, error: 'Lectura vacía.' };
    if (esDecimal(s)) {
      const sinCeros = s.replace(/^0+(?=\d)/, '');
      return { ok: true, principal: sinCeros, formato: 'decimal', alternativas: [] };
    }
    if (esHex(s)) {
      const bytes = bytesDesdeHex(s.toLowerCase());
      const be = desdeBytes(bytes).toString();
      const le = desdeBytes(bytes.slice().reverse()).toString();
      const alternativas = le !== be ? [le] : [];
      return { ok: true, principal: be, formato: 'hex', alternativas, aviso: alternativas.length ? 'Lectura hexadecimal: se guarda en decimal. Si el torno no la reconoce, prueba la alternativa (orden de bytes invertido).' : undefined };
    }
    if (/^\d+$/.test(s)) return { ok: false, error: `El UID debe tener entre 6 y 20 dígitos (leído: ${s.length}).` };
    return { ok: false, error: 'No parece un UID de pulsera (se esperan dígitos o hexadecimal).' };
  }

  /* Todas las formas decimales equivalentes de una lectura (para comparar con
     lo guardado): la principal + alternativas + el decimal de reinterpretar la
     entrada decimal como hex... no: solo principal y alternativas. */
  function variantes(entrada) {
    const n = normalizar(entrada);
    return n.ok ? [n.principal].concat(n.alternativas) : [];
  }

  /* Hex (mayúsculas, 4 bytes mínimo) de un decimal, para mostrarlo al admin. */
  function aHex(decimal) {
    try { return aBytes(BigInt(String(decimal)), 4).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase(); } catch (e) { return ''; }
  }

  return { normalizar, variantes, aHex, esDecimal, esHex };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MSDUid;
