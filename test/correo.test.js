'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const correo = require('../lib/correo.js');

test('construirMensaje: cabeceras RFC 2047 para no-ASCII, sin CR/LF inyectados, cuerpo base64 utf-8', () => {
  const m = correo.construirMensaje({ de: 'Deportes <no-reply@medinasidonia.es>', para: 'vecino@correo.es', asunto: 'Confirma tu correo — Deportes\r\nBcc: malo@x.es', texto: 'Hola, ñandú 🙂' });
  assert.match(m, /^From: Deportes <no-reply@medinasidonia\.es>\r\n/);
  assert.match(m, /\r\nTo: vecino@correo\.es\r\n/);
  assert.match(m, /\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/);   // codificado (tiene —)
  assert.doesNotMatch(m, /Bcc:/);                                        // la inyección CR/LF se aplanó en el subject codificado
  assert.match(m, /Content-Transfer-Encoding: base64/);
  const cuerpo = m.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  assert.equal(Buffer.from(cuerpo, 'base64').toString('utf8'), 'Hola, ñandú 🙂');
});

test('codificarPalabra deja ASCII tal cual y codifica UTF-8', () => {
  assert.equal(correo.codificarPalabra('Hola'), 'Hola');
  assert.equal(correo.codificarPalabra('Año'), '=?UTF-8?B?' + Buffer.from('Año', 'utf8').toString('base64') + '?=');
});

test('direccionValida', () => {
  assert.equal(correo.direccionValida('a@b.es'), true);
  assert.equal(correo.direccionValida('a@b'), false);
  assert.equal(correo.direccionValida('a b@c.es'), false);
  assert.equal(correo.direccionValida('<a@b.es>'), false);
});

test('plantillas llevan el enlace con el token en el fragmento #/ y no exponen otra cosa', () => {
  const viejo = process.env.MSD_URL_PUBLICA;
  process.env.MSD_URL_PUBLICA = 'https://deportes.example/';
  const p = correo.plantillas();
  const v = p.verificar('Carmen', 'TOKEN123');
  assert.match(v.texto, /https:\/\/deportes\.example\/#\/verificar\?token=TOKEN123/);
  const r = p.recuperar('Carmen', 'T2');
  assert.match(r.texto, /#\/restablecer\?token=T2/);
  assert.match(p.desbloquear('Carmen', 'T3').texto, /#\/restablecer\?token=T3/);
  if (viejo === undefined) delete process.env.MSD_URL_PUBLICA; else process.env.MSD_URL_PUBLICA = viejo;
});

/* Servidor SMTP falso (sin TLS, puerto 465 "implícito" no; usamos STARTTLS? no:
   para probar el diálogo sin certificados, el falso anuncia STARTTLS y el test
   comprueba que el cliente lo exige; y con port 2525 sin STARTTLS el cliente falla limpio). */
test('enviarSmtp: sin STARTTLS el cliente rechaza (no manda credenciales en claro)', async () => {
  const srv = net.createServer((sock) => {
    sock.write('220 falso ESMTP\r\n');
    sock.on('data', (d) => {
      const l = d.toString();
      if (/^EHLO/i.test(l)) sock.write('250-falso\r\n250 AUTH PLAIN\r\n');   // sin STARTTLS
      else sock.write('500 no\r\n');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    await assert.rejects(
      correo.enviarSmtp({ host: '127.0.0.1', port, user: 'u', pass: 'p', de: 'a@b.es', para: 'c@d.es', mensaje: 'Subject: x\r\n\r\nhola\r\n' }),
      /STARTTLS/
    );
  } finally { srv.close(); }
});

test('dot-stuffing: una línea que empieza por "." se duplica', () => {
  // reproducimos la transformación que aplica enviarSmtp antes de DATA
  const mensaje = 'Subject: x\r\n\r\n.inicio\r\nnormal\r\n..ya\r\n';
  const datos = mensaje.replace(/\r?\n\./g, (m) => m + '.');
  assert.equal(datos, 'Subject: x\r\n\r\n..inicio\r\nnormal\r\n...ya\r\n');
});
