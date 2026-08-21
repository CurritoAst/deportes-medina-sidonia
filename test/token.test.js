'use strict';
/* Paridad del QR dinámico: este vector NO puede cambiar nunca sin cambiar todos
   los carnets (servidor y Raspberry usan este mismo módulo). */
const test = require('node:test');
const assert = require('node:assert/strict');
const token = require('../lib/token.js');
const tokenTorno = require('../acceso/token.js');

test('vector de paridad fijo 71580974', () => {
  assert.equal(token.codigo('1399878112', 'a1b2c3d4e5f60001', 59000000), '71580974');
});

test('acceso/token.js es EXACTAMENTE el mismo módulo que lib/token.js', () => {
  assert.equal(tokenTorno, token);
  assert.equal(tokenTorno.codigo('1399878112', 'a1b2c3d4e5f60001', 59000000), '71580974');
});

test('generar + validar en la misma ventana y en ±2 ventanas; rechaza a ±3', () => {
  const uid = '1399878112', seed = 'a1b2c3d4e5f60001';
  const base = 58000000 * 30 * 1000;
  const g = token.generar(uid, seed, base);
  assert.equal(g.payload, uid + token.codigo(uid, seed, 58000000));
  const buscar = (u) => (u === uid ? seed : null);
  assert.equal(token.validar(g.payload, buscar, base).ok, true);
  assert.equal(token.validar(g.payload, buscar, base - 60000).ok, true);
  assert.equal(token.validar(g.payload, buscar, base + 60000).ok, true);
  assert.equal(token.validar(g.payload, buscar, base - 90001).ok, false);
});

test('validar: no reconocido, carnet desconocido, código de otro socio', () => {
  const buscar = (u) => (u === '1399878112' ? 'a1b2c3d4e5f60001' : null);
  assert.equal(token.validar('abc', buscar).ok, false);
  assert.equal(token.validar('12345', buscar).ok, false);                // demasiado corto
  assert.equal(token.validar('999999999900000000', buscar).motivo, 'Carnet no reconocido');
  const t = token.ventanaActual();
  const ajeno = '1399878112' + token.codigo('1399878112', 'otra-seed', t);
  assert.equal(token.validar(ajeno, buscar).ok, false);
});

test('generarLote devuelve N códigos consecutivos válidos', () => {
  const uid = '5550001234', seed = 'deadbeefdeadbeef';
  const base = 60000000 * 30 * 1000;
  const lote = token.generarLote(uid, seed, 20, base);
  assert.equal(lote.codigos.length, 20);
  assert.equal(lote.desdeT, 60000000);
  assert.equal(lote.codigos[0], token.codigo(uid, seed, 60000000));
  assert.equal(lote.codigos[19], token.codigo(uid, seed, 60000019));
  // el código de la ventana 7 valida si el torno está en la ventana 7
  const p = uid + lote.codigos[7];
  assert.equal(token.validar(p, () => seed, (60000007) * 30 * 1000).ok, true);
});

test('un UID con cero inicial se conserva como cadena', () => {
  const lote = token.generarLote('0642119837', 'a1b2c3d4e5f60002', 1, 0);
  assert.equal(lote.uid, '0642119837');
  assert.equal(token.codigo('0642119837', 'x', 1), token.codigo('0642119837', 'x', 1));
  assert.notEqual(token.codigo('0642119837', 'x', 1), token.codigo('642119837', 'x', 1));
});
