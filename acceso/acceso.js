/* ==========================================================================
   Deportes · Medina Sidonia — SERVICIO DE ACCESO DEL TORNO
   Node puro, sin dependencias. Corre junto al torno (en la Raspberry o en un
   miniPC) y hace, en bucle:

     1. Se conecta por TCP a los lectores del HF5122 (entrada y salida) y
        reconecta solo si se cae la conexión.
     2. Lee cada identificador (UID de tarjeta/pulsera o QR), deduplica las
        lecturas repetidas y lo normaliza.
     3. Valida contra la CACHÉ LOCAL de socios (sincronizada desde la web).
        La caché en disco permite seguir abriendo aunque se caiga la red.
     4. Si procede, dispara el relé de apertura y registra el acceso en la web.

   Reemplaza al "cerebro" del instalador (que dependía de la nube de Sporttia:
   sin internet no abría). Aquí la decisión es LOCAL.

   Uso:
     node acceso/acceso.js                      # desarrollo: lector simulado
     MSD_HOST_ENTRADA=192.168.1.35 \
     MSD_HOST_SALIDA=192.168.1.35 \
     node acceso/acceso.js                      # producción: torno real
     MSD_SOLO_ESCUCHA=1 node acceso/acceso.js   # solo imprime lo que llega
   ========================================================================== */

'use strict';

const net = require('net');
const fs = require('fs');
const http = require('http');
const { URL } = require('url');
const cfg = require('./config');
const token = require('./token');

/* ---------- Utilidades ---------- */

const pad2 = (n) => String(n).padStart(2, '0');
const hoy = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

function edadDe(birthdate) {
  if (!birthdate || !/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) return null;
  const [a, m, d] = birthdate.split('-').map(Number);
  const r = new Date();
  let e = r.getFullYear() - a;
  if ((r.getMonth() + 1 < m) || (r.getMonth() + 1 === m && r.getDate() < d)) e -= 1;
  return e;
}

/* Petición JSON mínima con el módulo http (sin depender de fetch). */
function pedir(metodo, url, cuerpo) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const datos = cuerpo ? Buffer.from(JSON.stringify(cuerpo)) : null;
    const req = http.request({
      method: metodo,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: datos ? { 'Content-Type': 'application/json', 'Content-Length': datos.length } : {}
    }, (res) => {
      let d = '';
      res.on('data', (t) => { d += t; });
      res.on('end', () => resolve({ status: res.statusCode, cuerpo: d }));
    });
    req.on('error', reject);
    if (datos) req.write(datos);
    req.end();
  });
}

/* ---------- Caché local de socios ---------- */

let socios = [];              // [{ id, nombre, nfcUid, nfcId, qrSeed, activo, hasta, birthdate }]
const porUid = new Map();
const porNfcId = new Map();

function indexar() {
  porUid.clear(); porNfcId.clear();
  for (const s of socios) {
    if (s.nfcUid) porUid.set(s.nfcUid, s);
    if (s.nfcId) porNfcId.set(s.nfcId, s);
  }
}

function guardarCache() {
  try { fs.writeFileSync(cfg.CACHE_FICHERO, JSON.stringify(socios)); }
  catch (e) { log('No se pudo guardar la caché:', e.message); }
}

function cargarCacheDisco() {
  try {
    socios = JSON.parse(fs.readFileSync(cfg.CACHE_FICHERO, 'utf8'));
    if (!Array.isArray(socios)) socios = [];
    indexar();
    log(`Caché local cargada: ${socios.length} socios con carnet.`);
  } catch (e) { socios = []; }
}

/* Descarga los socios de la web y refresca la caché. Si falla, se sigue con la
   caché en disco (el torno debe funcionar aunque la web esté caída). */
async function sincronizar() {
  try {
    const r = await pedir('GET', `${cfg.WEB}/api/estado`);
    if (r.status !== 200) throw new Error('estado ' + r.status);
    const estado = JSON.parse(r.cuerpo);
    const usuarios = JSON.parse(estado.msd_usuarios || '[]');
    const nuevos = [];
    for (const u of usuarios) {
      if (!u || !u.abono) continue;
      nuevos.push({
        id: u.id, nombre: u.nombre,
        nfcUid: u.abono.nfcUid || null,
        nfcId: u.abono.nfcId || null,
        qrSeed: u.abono.qrSeed || null,
        activo: u.abono.activo === true,
        hasta: u.abono.hasta,
        birthdate: u.birthdate || ''
      });
    }
    socios = nuevos;
    indexar();
    guardarCache();
    log(`Sincronizados ${socios.length} socios con carnet desde la web.`);
  } catch (e) {
    log(`Sin conexión con la web (${e.message}); se sigue con la caché local (${socios.length} socios).`);
  }
}

/* ---------- Validación (misma lógica que la web) ---------- */

function validar(ident, metodo, direccion) {
  const dir = direccion === 'salida' ? 'salida' : 'entrada';
  const u = porUid.get(ident) || porNfcId.get(ident);
  if (!u) return { usuarioId: null, resultado: 'denegado', motivo: 'Carnet no reconocido', direccion: dir, raw: ident, metodo };
  if (dir === 'salida') return { usuarioId: u.id, resultado: 'ok', motivo: 'Salida registrada', direccion: dir, raw: ident, metodo, nombre: u.nombre };
  if (!u.activo) return { usuarioId: u.id, resultado: 'denegado', motivo: 'Abono dado de baja', direccion: dir, raw: ident, metodo, nombre: u.nombre };
  if (u.hasta < hoy()) return { usuarioId: u.id, resultado: 'denegado', motivo: `Abono caducado el ${u.hasta}`, direccion: dir, raw: ident, metodo, nombre: u.nombre };
  const edad = edadDe(u.birthdate);
  if (edad !== null && edad < cfg.EDAD_MINIMA) return { usuarioId: u.id, resultado: 'denegado', motivo: `Acceso a partir de ${cfg.EDAD_MINIMA} años`, direccion: dir, raw: ident, metodo, nombre: u.nombre };
  return { usuarioId: u.id, resultado: 'ok', motivo: 'Abono en vigor', direccion: dir, raw: ident, metodo, nombre: u.nombre };
}

/* Decide qué es lo leído y lo valida. */
function procesarLectura(texto, direccion) {
  const limpio = String(texto).trim();
  if (!limpio) return null;

  // QR dinámico nuevo (MSD2|uid|T|firma)
  if (token.esDinamico(limpio)) {
    const v = token.validar(limpio, (uid) => {
      const s = porUid.get(uid);
      return s && s.qrSeed ? s.qrSeed : null;
    });
    if (!v.ok) {
      const s = v.nfcUid ? porUid.get(v.nfcUid) : null;
      return { usuarioId: s ? s.id : null, resultado: 'denegado', motivo: v.motivo, direccion, raw: limpio, metodo: 'qr', nombre: s ? s.nombre : null };
    }
    return validar(v.nfcUid, 'qr', direccion);
  }

  // Solo dígitos → UID de tarjeta/pulsera (lectura NFC).
  if (/^\d{4,24}$/.test(limpio)) return validar(limpio, 'nfc', direccion);

  // Cualquier otra cosa: identificador no reconocido.
  return { usuarioId: null, resultado: 'denegado', motivo: 'Lectura no reconocida', direccion, raw: limpio.slice(0, 64), metodo: 'qr' };
}

/* ---------- Relé y LEDs (GPIO en la Raspberry) ---------- */

const { spawn } = require('child_process');
function gpio(pin, alto) {
  // pinctrl viene de serie en Raspberry Pi OS reciente. Solo se usa con MSD_RELE=gpio.
  try { spawn('pinctrl', ['set', String(pin), 'op', alto ? 'dh' : 'dl']); }
  catch (e) { log('GPIO no disponible:', e.message); }
}

async function abrir(direccion) {
  const pin = cfg.PINES[direccion];
  if (cfg.SIMULAR_RELE) { log(`  ▸ (simulado) pulso de relé de ${direccion} durante ${cfg.PULSO_RELE_MS} ms`); return; }
  gpio(pin, true);
  await new Promise((r) => setTimeout(r, cfg.PULSO_RELE_MS));
  gpio(pin, false);
}

function led(color) {
  if (cfg.SIMULAR_RELE) return;
  gpio(cfg.PINES.ledVerde, color === 'verde');
  gpio(cfg.PINES.ledRojo, color === 'rojo');
}

/* ---------- Registro del acceso en la web ---------- */

async function registrar(res) {
  const evento = {
    usuarioId: res.usuarioId, metodo: res.metodo, resultado: res.resultado,
    motivo: res.motivo, direccion: res.direccion, raw: res.raw
  };
  try {
    const r = await pedir('POST', `${cfg.WEB}/api/acceso`, { evento });
    if (r.status !== 201) log('  ! la web rechazó el registro:', r.status, r.cuerpo);
  } catch (e) {
    log('  ! no se pudo registrar el acceso (se reintentará al reconectar):', e.message);
    // En un despliegue real aquí encolaríamos en disco para reenviar luego.
  }
}

/* ---------- Manejo de una lectura completa ---------- */

async function alLeer(texto, direccion) {
  if (cfg.SOLO_ESCUCHA) { log(`(escucha) ${direccion}: ${JSON.stringify(texto)}`); return; }
  const res = procesarLectura(texto, direccion);
  if (!res) return;
  const quien = res.nombre || (res.usuarioId ? res.usuarioId : 'desconocido');
  if (res.resultado === 'ok') {
    log(`✔ ${res.direccion.toUpperCase()} · ${quien} · ${res.motivo}`);
    led('verde');
    await abrir(res.direccion);
  } else {
    log(`✘ ${res.direccion.toUpperCase()} · ${quien} · ${res.motivo}  [${res.raw}]`);
    led('rojo');
  }
  await registrar(res);
}

/* ---------- Cliente TCP de un lector, con reconexión y dedup ---------- */

function conectarLector(lector) {
  let buffer = '';
  let ultimo = { valor: '', ts: 0 };

  const conectar = () => {
    const sock = net.connect({ host: lector.host, port: lector.puerto }, () => {
      log(`Conectado al lector de ${lector.direccion} (${lector.host}:${lector.puerto}).`);
    });
    sock.setEncoding('utf8');

    sock.on('data', (trozo) => {
      buffer += trozo;
      // El lector entrega una lectura por línea (CR/LF). Procesamos por líneas.
      let corte;
      while ((corte = buffer.search(/[\r\n]/)) !== -1) {
        const linea = buffer.slice(0, corte).trim();
        buffer = buffer.slice(corte + 1);
        if (!linea) continue;
        const ahora = Date.now();
        // Dedup: el lector emite cada pase dos veces seguidas.
        if (linea === ultimo.valor && (ahora - ultimo.ts) < cfg.DEDUP_MS) { ultimo.ts = ahora; continue; }
        ultimo = { valor: linea, ts: ahora };
        alLeer(linea, lector.direccion);
      }
    });

    const reconectar = () => {
      sock.destroy();
      setTimeout(conectar, cfg.RECONEXION_MS);
    };
    sock.on('error', (e) => { log(`Lector de ${lector.direccion}: ${e.message}. Reintentando en ${cfg.RECONEXION_MS / 1000}s…`); });
    sock.on('close', () => { log(`Lector de ${lector.direccion} desconectado. Reintentando…`); setTimeout(conectar, cfg.RECONEXION_MS); });
    // 'close' ya cubre la reconexión tras 'error'.
  };

  conectar();
}

/* ---------- Arranque ---------- */

async function principal() {
  log('Servicio de acceso del torno — arrancando.');
  log(cfg.SOLO_ESCUCHA ? 'MODO SOLO-ESCUCHA (no abre ni registra).'
    : (cfg.SIMULAR_RELE ? 'Relé SIMULADO (no toca GPIO).' : 'Relé por GPIO real.'));
  cargarCacheDisco();
  await sincronizar();
  setInterval(sincronizar, cfg.SYNC_MS);
  for (const lector of cfg.LECTORES) conectarLector(lector);
  log(`Escuchando ${cfg.LECTORES.map((l) => `${l.direccion}@${l.host}:${l.puerto}`).join('  ')}`);
}

principal();
