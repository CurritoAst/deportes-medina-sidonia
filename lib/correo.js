/* ==========================================================================
   Deportes · Medina Sidonia — correo saliente (SMTP mínimo + outbox)
   Sin dependencias: cliente SMTP con `net`/`tls` de Node (EHLO → STARTTLS o
   TLS implícito → AUTH PLAIN → MAIL/RCPT/DATA), suficiente para hablar con
   el servidor de correo de Plesk (Postfix). Variables:
     MSD_SMTP_HOST  hostname del correo (con certificado válido; no 'localhost')
     MSD_SMTP_PORT  587 (STARTTLS) | 465 (TLS implícito)      [def. 587]
     MSD_SMTP_USER / MSD_SMTP_PASS   buzón con el que se envía
     MSD_SMTP_DE    remitente visible, p. ej. 'Deportes Medina Sidonia <no-reply@dominio>'
     MSD_URL_PUBLICA  base de los enlaces de los correos
   Sin MSD_SMTP_HOST → MODO DESARROLLO: no envía; imprime por consola y anexa
   a <MSD_DATA_DIR>/correos-salientes.log (fuera de httpdocs).

   Todo envío pasa por la tabla `correos_salida` (outbox): sobrevive a un
   reinicio de Passenger; un bucle cada 30 s reintenta con backoff. Los
   fallos se anotan en registro_actividad (tipo 'correo').
   ========================================================================== */

'use strict';

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bd = require('./bd');

const TIMEOUT_MS = 15000;
const BACKOFF_MS = [10e3, 60e3, 5 * 60e3, 30 * 60e3, 2 * 3600e3];

function config() {
  return {
    host: process.env.MSD_SMTP_HOST || '',
    port: Number(process.env.MSD_SMTP_PORT || 587),
    user: process.env.MSD_SMTP_USER || '',
    pass: process.env.MSD_SMTP_PASS || '',
    de: process.env.MSD_SMTP_DE || process.env.MSD_SMTP_USER || 'no-reply@localhost',
    urlPublica: (process.env.MSD_URL_PUBLICA || '').replace(/\/+$/, ''),
    dirDatos: process.env.MSD_DATA_DIR || path.join(__dirname, '..', 'data')
  };
}
const modoDev = () => !config().host;

/* ---------- Construcción del mensaje (RFC 5322 mínimo, UTF-8) ---------- */
const limpiarCabecera = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
function codificarPalabra(s) {   // RFC 2047 si hay no-ASCII
  s = limpiarCabecera(s);
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}
function direccionValida(d) { return /^[^\s@<>]{1,64}@[^\s@<>]{1,189}\.[^\s@<>]{2,}$/.test(String(d || '')); }

function construirMensaje({ de, para, asunto, texto }) {
  const dominio = (String(de).match(/@([^>\s]+)/) || [, 'localhost'])[1];
  const id = `<${crypto.randomBytes(12).toString('hex')}@${dominio}>`;
  const cabeceras = [
    `From: ${limpiarCabecera(de)}`,
    `To: ${limpiarCabecera(para)}`,                        // solo la dirección, nunca el nombre del usuario
    `Subject: ${codificarPalabra(asunto)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    'X-Auto-Response-Suppress: All'
  ];
  const cuerpo = Buffer.from(String(texto), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return cabeceras.join('\r\n') + '\r\n\r\n' + cuerpo + '\r\n';
}

/* ---------- Cliente SMTP ---------- */
function enviarSmtp({ host, port, user, pass, de, para, mensaje }) {
  return new Promise((resolve, reject) => {
    const implicito = port === 465;
    let socket = implicito ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    let buffer = '';
    let resolver = null;
    let acabado = false;
    const fallar = (e) => { if (acabado) return; acabado = true; try { socket.destroy(); } catch (e2) { /* */ } reject(e instanceof Error ? e : new Error(String(e))); };
    const temporizador = setTimeout(() => fallar(new Error('SMTP: tiempo de espera agotado')), TIMEOUT_MS * 6);

    const alDato = (d) => {
      buffer += d.toString('utf8');
      // respuesta completa = última línea "NNN " (espacio tras el código)
      const lineas = buffer.split('\r\n').filter(Boolean);
      const ultima = lineas[lineas.length - 1];
      if (ultima && /^\d{3} /.test(ultima) && resolver) { const r = resolver; resolver = null; const b = buffer; buffer = ''; r(b); }
    };
    const esperar = () => new Promise((res) => { resolver = res; });
    const enviar = async (linea, esperados) => {
      socket.write(linea + '\r\n');
      const r = await esperar();
      const codigo = Number(r.slice(0, 3));
      if (!esperados.includes(codigo)) throw new Error(`SMTP ${linea.split(' ')[0]}: ${r.trim().slice(0, 200)}`);
      return r;
    };
    const engancharSocket = () => { socket.setTimeout(TIMEOUT_MS, () => fallar(new Error('SMTP: sin respuesta'))); socket.on('data', alDato); socket.on('error', fallar); };

    engancharSocket();
    (async () => {
      await esperar();                                        // 220 saludo
      let ehlo = await enviar('EHLO msd.local', [250]);
      if (!implicito) {
        if (!/STARTTLS/i.test(ehlo)) throw new Error('SMTP: el servidor no ofrece STARTTLS');
        await enviar('STARTTLS', [220]);
        socket.removeAllListeners('data');
        socket = tls.connect({ socket, servername: host }, () => {});
        engancharSocket();
        await new Promise((res, rej) => { socket.once('secureConnect', res); socket.once('error', rej); });
        ehlo = await enviar('EHLO msd.local', [250]);
      }
      if (user) {
        const plain = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
        await enviar(`AUTH PLAIN ${plain}`, [235]);
      }
      const deDir = (String(de).match(/<([^>]+)>/) || [, de])[1];
      await enviar(`MAIL FROM:<${deDir}>`, [250]);
      await enviar(`RCPT TO:<${para}>`, [250, 251]);
      await enviar('DATA', [354]);
      const datos = mensaje.replace(/\r?\n\./g, (m) => m + '.');   // dot-stuffing
      await enviar(datos + '\r\n.', [250]);
      try { await enviar('QUIT', [221]); } catch (e) { /* algunos cierran antes */ }
      clearTimeout(temporizador); acabado = true; socket.end(); resolve(true);
    })().catch((e) => { clearTimeout(temporizador); fallar(e); });
  });
}

/* ---------- Outbox ---------- */
/* Encola un correo. Si hay BD, va a correos_salida (y se intenta enviar ya);
   sin BD ni SMTP (dev puro), se escribe al log directamente. */
async function encolar({ para, asunto, texto }) {
  if (!direccionValida(para)) throw new Error('Dirección de correo no válida');
  asunto = limpiarCabecera(asunto).slice(0, 200);
  if (!bd.configurada()) { await volcarDev({ para, asunto, texto }); return { id: null, modo: 'dev' }; }
  const r = await bd.consulta('INSERT INTO correos_salida (para, asunto, cuerpo_texto) VALUES (?, ?, ?)', [para, asunto, String(texto)]);
  const id = r.insertId;
  setImmediate(() => procesarPendientes().catch(() => {}));   // envío inmediato además del bucle
  return { id, modo: modoDev() ? 'dev' : 'smtp' };
}

async function volcarDev(c) {
  const cfg = config();
  const linea = `\n===== ${new Date().toISOString()} · Para: ${c.para} · Asunto: ${c.asunto} =====\n${c.texto}\n`;
  console.log('[correo:dev]' + linea);
  try { fs.mkdirSync(cfg.dirDatos, { recursive: true }); fs.appendFileSync(path.join(cfg.dirDatos, 'correos-salientes.log'), linea); } catch (e) { /* opcional */ }
}

let procesando = false;
async function procesarPendientes() {
  if (procesando || !bd.configurada()) return { enviados: 0 };
  procesando = true;
  let enviados = 0;
  try {
    const ahora = new Date();
    const pendientes = await bd.consulta('SELECT id, para, asunto, cuerpo_texto, intentos FROM correos_salida WHERE enviado_en IS NULL AND proximo_en <= ? ORDER BY id LIMIT 20', [ahora]);
    for (const c of pendientes) {
      try {
        if (modoDev()) await volcarDev({ para: c.para, asunto: c.asunto, texto: c.cuerpo_texto });
        else {
          const cfg = config();
          await enviarSmtp({ host: cfg.host, port: cfg.port, user: cfg.user, pass: cfg.pass, de: cfg.de, para: c.para,
            mensaje: construirMensaje({ de: cfg.de, para: c.para, asunto: c.asunto, texto: c.cuerpo_texto }) });
        }
        await bd.consulta('UPDATE correos_salida SET enviado_en = ?, intentos = intentos + 1, ultimo_error = NULL WHERE id = ?', [new Date(), c.id]);
        enviados++;
      } catch (e) {
        const n = c.intentos + 1;
        const espera = BACKOFF_MS[Math.min(n - 1, BACKOFF_MS.length - 1)];
        await bd.consulta('UPDATE correos_salida SET intentos = ?, proximo_en = ?, ultimo_error = ? WHERE id = ?', [n, new Date(Date.now() + espera), String(e.message).slice(0, 255), c.id]);
        try { await bd.consulta("INSERT INTO registro_actividad (tipo, texto, entidad, entidad_id) VALUES ('correo', ?, 'correo', ?)", [`Fallo enviando correo a ${c.para} (intento ${n}): ${String(e.message).slice(0, 200)}`, String(c.id)]); } catch (e2) { /* */ }
        console.error(`[correo] fallo a ${c.para} (intento ${n}): ${e.message}`);
      }
    }
  } finally { procesando = false; }
  return { enviados };
}

let bucle = null;
function arrancarBucle() {
  if (bucle || !bd.configurada()) return;
  bucle = setInterval(() => procesarPendientes().catch((e) => console.error('[correo] bucle:', e.message)), 30e3);
  bucle.unref();
}

/* ---------- Plantillas (texto plano, español) ---------- */
const FIRMA = '\n\n— Deportes · Medina Sidonia\nComplejo Deportivo Prado de la Feria\n(Este es un mensaje automático; no respondas a este correo.)';

function plantillas() {
  const base = config().urlPublica || 'http://localhost:8137';
  return {
    verificar: (nombre, token) => ({
      asunto: 'Confirma tu correo — Deportes Medina Sidonia',
      texto: `Hola, ${nombre}.\n\nPara activar tu cuenta en la web de deportes, confirma tu correo abriendo este enlace (caduca en 24 horas):\n\n${base}/#/verificar?token=${token}\n\nSi no has creado tú esta cuenta, ignora este mensaje.${FIRMA}`
    }),
    yaRegistrado: (nombre) => ({
      asunto: 'Intento de registro con tu correo — Deportes Medina Sidonia',
      texto: `Hola, ${nombre}.\n\nAlguien ha intentado crear una cuenta con este correo, pero ya tienes una. Si has sido tú, entra con tu contraseña o usa "He olvidado mi contraseña".\n\nSi no has sido tú, no tienes que hacer nada.${FIRMA}`
    }),
    recuperar: (nombre, token) => ({
      asunto: 'Restablecer tu contraseña — Deportes Medina Sidonia',
      texto: `Hola, ${nombre}.\n\nPara elegir una contraseña nueva abre este enlace (caduca en 1 hora):\n\n${base}/#/restablecer?token=${token}\n\nSi no lo has pedido tú, ignora este mensaje: tu contraseña no cambia.${FIRMA}`
    }),
    claveCambiada: (nombre) => ({
      asunto: 'Tu contraseña ha cambiado — Deportes Medina Sidonia',
      texto: `Hola, ${nombre}.\n\nTe avisamos de que la contraseña de tu cuenta se ha cambiado hace un momento y se han cerrado las sesiones abiertas.\n\nSi no has sido tú, usa "He olvidado mi contraseña" cuanto antes o pásate por la oficina de deportes.${FIRMA}`
    }),
    invitacion: (nombre, token) => ({
      asunto: 'Tu cuenta en la web de deportes — Medina Sidonia',
      texto: `Hola, ${nombre}.\n\nTe hemos creado una cuenta en la web de deportes del Ayuntamiento. Para elegir tu contraseña abre este enlace (caduca en 7 días):\n\n${base}/#/restablecer?token=${token}${FIRMA}`
    }),
    desbloquear: (nombre, token) => ({
      asunto: 'Desbloquea tu cuenta — Deportes Medina Sidonia',
      texto: `Hola, ${nombre}.\n\nHemos detectado demasiados intentos fallidos de entrar en tu cuenta, así que la hemos protegido temporalmente. Para desbloquearla y elegir una contraseña nueva abre este enlace (caduca en 1 hora):\n\n${base}/#/restablecer?token=${token}\n\nSi no has sido tú, cambia la contraseña igualmente.${FIRMA}`
    })
  };
}

module.exports = { encolar, procesarPendientes, arrancarBucle, construirMensaje, enviarSmtp, plantillas, modoDev, direccionValida, limpiarCabecera, codificarPalabra };
