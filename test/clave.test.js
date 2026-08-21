'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const clave = require('../lib/clave.js');

test('hashear produce formato PHC y verificar acepta la correcta y rechaza otras', async () => {
  const h = await clave.hashear('MiContraseñaSegura2026');
  assert.match(h, /^scrypt\$15\$8\$3\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.deepEqual(await clave.verificar('MiContraseñaSegura2026', h), { ok: true, rehash: false });
  assert.equal((await clave.verificar('MiContraseñaSegura2027', h)).ok, false);
  assert.equal((await clave.verificar('', h)).ok, false);
});

test('dos hashes de la misma clave son distintos (sal aleatoria)', async () => {
  const a = await clave.hashear('repetida-repetida');
  const b = await clave.hashear('repetida-repetida');
  assert.notEqual(a, b);
});

test('verificar con formato corrupto devuelve ok=false sin lanzar', async () => {
  assert.equal((await clave.verificar('x', 'basura')).ok, false);
  assert.equal((await clave.verificar('x', '')).ok, false);
  assert.equal((await clave.verificar('x', null)).ok, false);
  assert.equal((await clave.verificar('x', 'scrypt$99$8$3$aa$bb')).ok, false); // N fuera de rango
  assert.equal((await clave.verificar('x', 'sha256$abc')).ok, false);
});

test('rehash=true cuando los parámetros guardados difieren de los vigentes', async () => {
  // Hash con N=2^14 (parámetros "antiguos") generado a mano
  const crypto = require('crypto');
  const sal = crypto.randomBytes(16);
  const k = crypto.scryptSync('clave-antigua-2026', sal, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const viejo = `scrypt$14$8$1$${sal.toString('base64url')}$${k.toString('base64url')}`;
  const r = await clave.verificar('clave-antigua-2026', viejo);
  assert.equal(r.ok, true);
  assert.equal(r.rehash, true);
});

test('política de contraseñas', () => {
  assert.equal(clave.politicaClave('corta1'), 'La contraseña debe tener al menos 10 caracteres.');
  assert.match(clave.politicaClave('password123'), /común/);
  assert.match(clave.politicaClave('carmen.aragon-2026!', { email: 'carmen.aragon@correo.es' }), /correo/);
  assert.match(clave.politicaClave('SoyAragonVela99', { nombre: 'Carmen Aragón Vela' }), /nombre/);
  assert.equal(clave.politicaClave('una frase larga y segura 2026', { nombre: 'Carmen Aragón Vela', email: 'carmen@correo.es' }), null);
  assert.equal(clave.politicaClave('x'.repeat(129)), 'La contraseña es demasiado larga (máximo 128).');
});

test('hashDummy es estable (se usa para igualar tiempos)', async () => {
  const a = await clave.hashDummy();
  const b = await clave.hashDummy();
  assert.equal(a, b);
});
