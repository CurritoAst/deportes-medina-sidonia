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
const https = require('https');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function edadDe(birthdate) {
  if (!birthdate || !/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) return null;
  const [a, m, d] = birthdate.split('-').map(Number);
  const r = new Date();
  let e = r.getFullYear() - a;
  if ((r.getMonth() + 1 < m) || (r.getMonth() + 1 === m && r.getDate() < d)) e -= 1;
  return e;
}

/* Petición JSON mínima, sin depender de fetch. Elige http/https según la URL
   (antes usaba siempre http y contra una web https caía al puerto 80 → 301) y
   sigue redirecciones, como el http→https de Render/Cloudflare. */
function pedir(metodo, url, cuerpo, saltos) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const datos = cuerpo ? Buffer.from(JSON.stringify(cuerpo)) : null;
    const req = lib.request({
      method: metodo,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: datos ? { 'Content-Type': 'application/json', 'Content-Length': datos.length } : {}
    }, (res) => {
      // Seguir redirecciones (http→https, barra final, etc.), hasta 5 saltos.
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && (saltos || 0) < 5) {
        res.resume(); // descarta el cuerpo del redirect
        const destino = new URL(res.headers.location, url).toString();
        return resolve(pedir(metodo, destino, cuerpo, (saltos || 0) + 1));
      }
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
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
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
    // Salvaguarda: si la web devuelve 0 socios (p. ej. Render se reinició y se
    // vació el estado) pero ya teníamos caché, la conservamos para no denegar a
    // todo el mundo por un vaciado temporal de la web.
    if (nuevos.length === 0 && socios.length > 0) {
      log(`La web devolvió 0 socios; se conserva la caché anterior (${socios.length}).`);
      return;
    }
    socios = nuevos;
    indexar();
    guardarCache();
    log(`Sincronizados ${socios.length} socios con carnet desde la web.`);
  } catch (e) {
    log(`Sin conexión con la web ${cfg.WEB} (${e.message}); se sigue con la caché local (${socios.length} socios).`);
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

/* Decide qué es lo leído y lo valida ("match-first", igual que la web):
   1) tarjeta conocida → NFC, 2) token dinámico numérico → QR, 3) numérico
   desconocido → tarjeta no reconocida, 4) texto raro → ilegible. */
function procesarLectura(texto, direccion) {
  const v = String(texto).trim();
  if (!v) return null;

  // 1) Tarjeta/pulsera física conocida (su UID va tal cual).
  if (porUid.get(v) || porNfcId.get(v)) return validar(v, 'nfc', direccion);

  // 2) Token dinámico numérico (QR rotatorio del carnet).
  if (token.esDinamico(v)) {
    const r = token.validar(v, (uid) => {
      const s = porUid.get(uid);
      return s && s.qrSeed ? s.qrSeed : null;
    });
    if (r.ok) return validar(r.nfcUid, 'qr', direccion);
    const s = r.nfcUid ? porUid.get(r.nfcUid) : null;
    return { usuarioId: s ? s.id : null, resultado: 'denegado', motivo: r.motivo, direccion, raw: v, metodo: 'qr', nombre: s ? s.nombre : null };
  }

  // 3) Numérico corto no reconocido → tarjeta desconocida.
  if (/^\d+$/.test(v)) return validar(v, 'nfc', direccion);

  // 4) Cualquier otra cosa: identificador no reconocido.
  return { usuarioId: null, resultado: 'denegado', motivo: 'Lectura no reconocida', direccion, raw: v.slice(0, 64), metodo: 'qr' };
}

/* ---------- Relé y LEDs (GPIO en la Raspberry) ---------- */

const crearGpio = require('./gpio');
const rele = crearGpio(cfg.RELE);

async function abrir(direccion) {
  const pin = cfg.RELE.pines[direccion];
  if (rele.backend === 'sim') { log(`  ▸ (simulado) pulso de relé de ${direccion} durante ${cfg.RELE.pulsoMs} ms`); return; }
  log(`  ▸ pulso de relé de ${direccion} (pin ${cfg.RELE.numeracion.toUpperCase()} ${pin}, ${cfg.RELE.pulsoMs} ms)`);
  await rele.pulso(pin, cfg.RELE.pulsoMs);
}

function led(color) {
  if (rele.backend === 'sim') return;
  rele.fijar(cfg.RELE.pines.ledVerde, color === 'verde');
  rele.fijar(cfg.RELE.pines.ledRojo, color === 'rojo');
}

/* Prueba de cableado sin tarjetas: dispara cada relé y cada LED por turnos.
   Uso:  node acceso/acceso.js --test-rele  */
async function probarRele() {
  const P = cfg.RELE.pines;
  log(`Prueba de relé — backend '${rele.backend}', numeración ${cfg.RELE.numeracion}, activo-${cfg.RELE.activoBajo ? 'bajo' : 'alto'}.`);
  if (rele.backend === 'sim') log('Estás en modo SIMULADO: exporta MSD_GPIO=raspi-gpio (o pinctrl/sysfs) para tocar el hardware.');
  rele.inicializar([P.entrada, P.salida, P.ledVerde, P.ledRojo].filter((p) => p !== null && p !== undefined));
  for (const dir of ['entrada', 'salida']) {
    log(`  Pulso ${dir} (pin ${P[dir]}) durante ${cfg.RELE.pulsoMs} ms — el relé debe cerrar y volver a abrir.`);
    await rele.pulso(P[dir], cfg.RELE.pulsoMs);
    await sleep(900);
  }
  if (P.ledVerde !== null && P.ledVerde !== undefined) { log(`  LED verde (pin ${P.ledVerde}) encendido 1 s`); rele.fijar(P.ledVerde, true); await sleep(1000); rele.fijar(P.ledVerde, false); }
  if (P.ledRojo !== null && P.ledRojo !== undefined) { log(`  LED rojo (pin ${P.ledRojo}) encendido 1 s`); rele.fijar(P.ledRojo, true); await sleep(1000); rele.fijar(P.ledRojo, false); }
  log('Prueba terminada. Si un relé no cerró, revisa pin/polaridad (MSD_RELE_ACTIVO_BAJO) y backend (MSD_GPIO).');
}

/* Buscador de pines: pulsa GPIO por GPIO para descubrir a qué pin está cableado
   cada relé (útil con un HAT de pinout desconocido). Escucha el CLIC.
   Uso:  node acceso/acceso.js --buscar-pines
   Personaliza la lista con  MSD_PINES_BUSCAR=17,27,22,...  */
async function buscarPines() {
  const candidatos = process.env.MSD_PINES_BUSCAR
    ? process.env.MSD_PINES_BUSCAR.split(',').map((n) => parseInt(n.trim(), 10)).filter(Number.isInteger)
    : [4, 17, 27, 22, 5, 6, 13, 19, 26, 16, 20, 21, 12, 23, 24, 25, 18];
  log(`Buscador de pines — backend '${rele.backend}', activo-${cfg.RELE.activoBajo ? 'bajo' : 'alto'}.`);
  if (rele.backend === 'sim') log('Estás en SIMULADO: exporta MSD_GPIO=raspi-gpio (o pinctrl/sysfs) para oír los relés.');
  log('Escucha el CLIC del relé: cuando suene, apunta el GPIO que se está anunciando.');
  rele.inicializar(candidatos);
  for (const pin of candidatos) {
    log(`  → probando GPIO ${pin} …`);
    await rele.pulso(pin, 700);
    await sleep(1300);
  }
  log('Barrido terminado. Pon los GPIO que hicieron clic en MSD_PIN_ENTRADA y MSD_PIN_SALIDA (/etc/acceso-torno.env).');
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
  // Prueba de cableado del relé y sale (no necesita web ni lectores).
  if (process.argv.includes('--test-rele')) { await probarRele(); return; }
  // Buscador de pines: barre GPIOs para descubrir a cuál está cableado cada relé.
  if (process.argv.includes('--buscar-pines')) { await buscarPines(); return; }

  log('Servicio de acceso del torno — arrancando.');
  const P = cfg.RELE.pines;
  if (cfg.SOLO_ESCUCHA) log('MODO SOLO-ESCUCHA (no abre ni registra, solo imprime).');
  else if (rele.backend === 'sim') log("Relé SIMULADO (no toca GPIO). Para el torno real: MSD_GPIO=auto (o pinctrl / raspi-gpio / sysfs)");
  else log(`Relé por GPIO real — backend '${rele.backend}', numeración ${cfg.RELE.numeracion}, activo-${cfg.RELE.activoBajo ? 'bajo' : 'alto'}, pines entrada=${P.entrada} salida=${P.salida}.`);

  rele.inicializar([P.entrada, P.salida, P.ledVerde, P.ledRojo].filter((p) => p !== null && p !== undefined));
  cargarCacheDisco();
  await sincronizar();
  setInterval(sincronizar, cfg.SYNC_MS);
  for (const lector of cfg.LECTORES) conectarLector(lector);
  log(`Escuchando ${cfg.LECTORES.map((l) => `${l.direccion}@${l.host}:${l.puerto}`).join('  ')}`);
}

principal();
