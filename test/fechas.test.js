'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../lib/fechas.js');

test('claveDia usa Europe/Madrid, no UTC', () => {
  // 2026-08-20 23:30 UTC = 2026-08-21 01:30 Madrid (CEST, +2)
  assert.equal(f.claveDia(new Date('2026-08-20T23:30:00Z')), '2026-08-21');
  // 2026-01-15 23:30 UTC = 2026-01-16 00:30 Madrid (CET, +1)
  assert.equal(f.claveDia(new Date('2026-01-15T23:30:00Z')), '2026-01-16');
  // 2026-01-15 22:30 UTC sigue siendo el 15 en Madrid
  assert.equal(f.claveDia(new Date('2026-01-15T22:30:00Z')), '2026-01-15');
});

test('horaTexto y minutosDelDia en Madrid', () => {
  const d = new Date('2026-08-20T11:47:19Z'); // 13:47:19 Madrid
  assert.equal(f.horaTexto(d), '13:47:19');
  assert.equal(f.minutosDelDia(d), 13 * 60 + 47);
});

test('esClaveDia acepta fechas reales y rechaza las imposibles', () => {
  assert.equal(f.esClaveDia('2026-02-28'), true);
  assert.equal(f.esClaveDia('2028-02-29'), true);   // bisiesto
  assert.equal(f.esClaveDia('2026-02-29'), false);
  assert.equal(f.esClaveDia('2026-13-01'), false);
  assert.equal(f.esClaveDia('26-1-1'), false);
  assert.equal(f.esClaveDia(''), false);
  assert.equal(f.esClaveDia(null), false);
});

test('sumarDias y sumarMeses (31 ene + 1 mes = último de feb)', () => {
  assert.equal(f.sumarDias('2026-08-31', 1), '2026-09-01');
  assert.equal(f.sumarDias('2026-12-31', 1), '2027-01-01');
  assert.equal(f.sumarDias('2026-03-01', -1), '2026-02-28');
  assert.equal(f.sumarMeses('2026-01-31', 1), '2026-02-28');
  assert.equal(f.sumarMeses('2028-01-31', 1), '2028-02-29');
  assert.equal(f.sumarMeses('2026-08-20', 1), '2026-09-20');
  assert.equal(f.sumarMeses('2026-12-15', 1), '2027-01-15');
});

test('edad cumplida (16 años justo hoy cuenta como 16)', () => {
  assert.equal(f.edad('2010-08-21', '2026-08-21'), 16);
  assert.equal(f.edad('2010-08-22', '2026-08-21'), 15);
  assert.equal(f.edad('1985-04-12', '2026-08-21'), 41);
  assert.equal(f.edad('', '2026-08-21'), null);
});

test('diaSemana en Madrid', () => {
  // 2026-08-21 es viernes (5); a las 23:30 UTC del jueves 20 ya es viernes en Madrid
  assert.equal(f.diaSemana(new Date('2026-08-20T23:30:00Z')), 5);
  assert.equal(f.diaSemana(new Date('2026-08-23T10:00:00Z')), 0); // domingo
});
