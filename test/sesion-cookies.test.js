'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sesion = require('../lib/sesion.js');

test('leerCookies parsea varias y se queda con la primera repetida', () => {
  const c = sesion.leerCookies({ headers: { cookie: '__Host-msd_sid=abc; otra=1; __Host-msd_sid=xyz; vacia=' } });
  assert.equal(c['__Host-msd_sid'], 'abc');
  assert.equal(c.otra, '1');
  assert.deepEqual(sesion.leerCookies({ headers: {} }), {});
});

test('esHttps: x-forwarded-proto manda; MSD_HTTPS fuerza', () => {
  const viejo = process.env.MSD_HTTPS; delete process.env.MSD_HTTPS;
  assert.equal(sesion.esHttps({ headers: { 'x-forwarded-proto': 'https' }, socket: {} }), true);
  assert.equal(sesion.esHttps({ headers: { 'x-forwarded-proto': 'http' }, socket: {} }), false);
  assert.equal(sesion.esHttps({ headers: {}, socket: { encrypted: true } }), true);
  assert.equal(sesion.esHttps({ headers: {}, socket: {} }), false);
  process.env.MSD_HTTPS = '1';
  assert.equal(sesion.esHttps({ headers: {}, socket: {} }), true);
  if (viejo === undefined) delete process.env.MSD_HTTPS; else process.env.MSD_HTTPS = viejo;
});

test('nombre de cookie: __Host- en https, msd_sid en http', () => {
  const viejo = process.env.MSD_HTTPS; delete process.env.MSD_HTTPS;
  assert.equal(sesion.nombreCookie({ headers: { 'x-forwarded-proto': 'https' }, socket: {} }), '__Host-msd_sid');
  assert.equal(sesion.nombreCookie({ headers: {}, socket: {} }), 'msd_sid');
  if (viejo !== undefined) process.env.MSD_HTTPS = viejo;
});

test('duraciones por rol: admin/monitor más cortas que vecino', () => {
  assert.ok(sesion.DURACION.admin.inactividad < sesion.DURACION.vecino.inactividad);
  assert.ok(sesion.DURACION.monitor.absoluto < sesion.DURACION.vecino.absoluto);
});
