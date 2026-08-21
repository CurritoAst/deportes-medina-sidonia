'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const limite = require('../lib/limite.js');

test('ventana deslizante: permite hasta max y luego bloquea con reintentarEn', () => {
  limite.vaciarTodo();
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(limite.intento('k', 3, 60e3, t0 + i * 1000).permitido, true);
  const r = limite.intento('k', 3, 60e3, t0 + 5000);
  assert.equal(r.permitido, false);
  assert.equal(r.reintentarEn, 55);              // el primero caduca a t0+60s
  // pasada la ventana vuelve a permitir
  assert.equal(limite.intento('k', 3, 60e3, t0 + 61e3).permitido, true);
});

test('claves independientes no se mezclan', () => {
  limite.vaciarTodo();
  assert.equal(limite.intento('a', 1, 60e3, 1).permitido, true);
  assert.equal(limite.intento('a', 1, 60e3, 2).permitido, false);
  assert.equal(limite.intento('b', 1, 60e3, 3).permitido, true);
});

test('comprobar() usa las reglas centralizadas', () => {
  limite.vaciarTodo();
  for (let i = 0; i < 5; i++) assert.equal(limite.comprobar('loginEmailIp', 'x@y.es|1.2.3.4', 100 + i).permitido, true);
  assert.equal(limite.comprobar('loginEmailIp', 'x@y.es|1.2.3.4', 200).permitido, false);
  assert.equal(limite.comprobar('loginEmailIp', 'x@y.es|9.9.9.9', 200).permitido, true); // otra IP, otra clave
  assert.throws(() => limite.comprobar('inexistente', 'x'));
});

test('ipCliente: socket loopback → último X-Forwarded-For; socket real → ignora XFF', () => {
  const req = (remote, headers) => ({ socket: { remoteAddress: remote }, headers: headers || {} });
  assert.equal(limite.ipCliente(req('127.0.0.1', { 'x-forwarded-for': '1.1.1.1, 81.40.162.177' })), '81.40.162.177');
  assert.equal(limite.ipCliente(req('::1', { 'x-real-ip': '81.40.162.177' })), '81.40.162.177');
  assert.equal(limite.ipCliente(req('::ffff:127.0.0.1', { 'x-forwarded-for': 'basura' })), '::ffff:127.0.0.1');
  assert.equal(limite.ipCliente(req('81.40.162.177', { 'x-forwarded-for': '9.9.9.9' })), '81.40.162.177');
  assert.equal(limite.ipCliente(req(undefined, {})), '0.0.0.0');
});
