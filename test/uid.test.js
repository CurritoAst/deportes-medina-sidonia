'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const uid = require('../lib/uid.js');

test('decimal: se acepta tal cual (sin ceros a la izquierda) y sin alternativas', () => {
  const n = uid.normalizar(' 1399878112 ');
  assert.deepEqual(n, { ok: true, principal: '1399878112', formato: 'decimal', alternativas: [] });
  assert.equal(uid.normalizar('0642119837').principal, '642119837');
  assert.equal(uid.normalizar('000000').principal, '0');
});

test('hex: big-endian como principal y little-endian como alternativa', () => {
  // 1399878112 = 0x53 0x70 0x71 0xE0
  const n = uid.normalizar('537071E0');
  assert.equal(n.ok, true); assert.equal(n.formato, 'hex');
  assert.equal(n.principal, '1399878112');
  assert.deepEqual(n.alternativas, ['3765530707']);   // E0 71 70 53 (bytes invertidos)
  // con separadores, 0x y minúsculas
  assert.equal(uid.normalizar('53:70:71:e0').principal, '1399878112');
  assert.equal(uid.normalizar('0x537071E0').principal, '1399878112');
  assert.equal(uid.normalizar('53-70-71-E0').principal, '1399878112');
});

test('el decimal que escribe un lector little-endian se reconoce como variante', () => {
  const le = uid.normalizar('E0717053').principal;   // bytes invertidos
  assert.equal(le, '3765530707');
  assert.ok(uid.variantes('537071E0').includes(le));
});

test('7 bytes (Mifare Ultralight/NTAG) y hex largo', () => {
  const n = uid.normalizar('04A2B3C4D5E6F7');
  assert.equal(n.ok, true); assert.equal(n.formato, 'hex');
  assert.match(n.principal, /^\d+$/);
  assert.ok(n.principal.length <= 20);
});

test('rechazos claros', () => {
  assert.equal(uid.normalizar('').ok, false);
  assert.equal(uid.normalizar('12345').ok, false);                // 5 dígitos
  assert.match(uid.normalizar('12345').error, /6 y 20/);
  assert.equal(uid.normalizar('hola-mundo').ok, false);
  assert.equal(uid.normalizar('NFC-ABCD1234').ok, false);          // el id legado no es un UID
});

test('aHex de un decimal', () => {
  assert.equal(uid.aHex('1399878112'), '537071E0');
  assert.equal(uid.aHex('1'), '00000001');
});
