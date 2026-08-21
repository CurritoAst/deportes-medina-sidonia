'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ta = require('../lib/torno-auth.js');

const TOKEN = 'a'.repeat(64);
const OTRO = 'b'.repeat(64);

test('tokensConfigurados parsea "nombre:token" en lista y descarta los cortos', () => {
  const l = ta.tokensConfigurados(`torno-pabellon:${TOKEN}, viejo:${OTRO},corto:abc`);
  assert.equal(l.length, 2);
  assert.equal(l[0].nombre, 'torno-pabellon');
  assert.equal(l[1].nombre, 'viejo');
  // sin nombre → 'torno'
  assert.equal(ta.tokensConfigurados(TOKEN)[0].nombre, 'torno');
  assert.equal(ta.tokensConfigurados('').length, 0);
});

test('autenticar acepta cualquiera de los tokens vigentes (rotación) y rechaza el resto', () => {
  const tokens = ta.tokensConfigurados(`nuevo:${TOKEN},antiguo:${OTRO}`);
  const req = (h) => ({ headers: h || {} });
  assert.deepEqual(ta.autenticar(req({ authorization: `Bearer ${TOKEN}`, 'x-torno-version': 'abc123' }), tokens), { dispositivo: 'nuevo' });
  assert.deepEqual(ta.autenticar(req({ authorization: `Bearer ${OTRO}` }), tokens), { dispositivo: 'antiguo' });
  assert.equal(ta.autenticar(req({ authorization: `Bearer ${'c'.repeat(64)}` }), tokens), null);
  assert.equal(ta.autenticar(req({ authorization: `Basic ${TOKEN}` }), tokens), null);
  assert.equal(ta.autenticar(req({}), tokens), null);
  assert.equal(ta.autenticar(req({ authorization: 'Bearer corto' }), tokens), null);
  // estado en memoria actualizado
  assert.equal(ta.estado.nombre, 'antiguo');
  assert.equal(ta.estado.version, 'abc123');
  assert.ok(Date.now() - ta.estado.ultimoContacto < 5000);
});
