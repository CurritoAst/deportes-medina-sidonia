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

/* Hora "de pared" en Europe/Madrid, independiente de la TZ del sistema.
   OJO: esto es solo para el LOG y para la fecha del abono (comparar con hasta).
   La validación del QR NO usa esto: usa epoch UTC (Date.now()) en token.js. */
const ZONA = process.env.MSD_TZ || 'Europe/Madrid';
function partesLocales(d) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  return p;
}
const hoy = () => { const p = partesLocales(new Date()); return `${p.year}-${p.month}-${p.day}`; };
const ts = () => { const p = partesLocales(new Date()); return `${p.hour}:${p.minute}:${p.second}`; };
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
function pedir(metodo, url, cuerpo, saltos, extraCabeceras) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const datos = cuerpo ? Buffer.from(JSON.stringify(cuerpo)) : null;
    const cab = Object.assign({}, datos ? { 'Content-Type': 'application/json', 'Content-Length': datos.length } : {}, extraCabeceras || {});
    // El token del torno SOLO se envía al host de la web configurada (nunca se
    // reenvía a otro host si hubiera una redirección a un dominio distinto).
    if (cfg.TOKEN && mismoHost(u, cfg.WEB)) cab.Authorization = `Bearer ${cfg.TOKEN}`;
    cab['X-Torno-Version'] = VERSION_TORNO;
    const req = lib.request({
      method: metodo,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: cab
    }, (res) => {
      // Seguir redirecciones (http→https, barra final, etc.), hasta 5 saltos.
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && (saltos || 0) < 5) {
        res.resume(); // descarta el cuerpo del redirect
        const destino = new URL(res.headers.location, url).toString();
        return resolve(pedir(metodo, destino, cuerpo, (saltos || 0) + 1, extraCabeceras));
      }
      let d = '';
      res.on('data', (t) => { d += t; });
      res.on('end', () => resolve({ status: res.statusCode, cuerpo: d, cabeceras: res.headers }));
    });
    // Sin timeout una conexión colgada bloquearía la sync para siempre.
    req.setTimeout(cfg.TIMEOUT_MS, () => req.destroy(new Error('tiempo de espera agotado')));
    req.on('error', reject);
    if (datos) req.write(datos);
    req.end();
  });
}
function mismoHost(u, base) { try { return new URL(base).host === u.host; } catch (e) { return false; } }
const VERSION_TORNO = (() => { try { return require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { return 'desconocida'; } })();

/* Escritura ATÓMICA de un JSON: escribe en .tmp y renombra (un corte de luz a
   mitad de escritura no deja un fichero corrupto). Permisos 0600 (la caché
   contiene las semillas del QR). */
function escribirJsonAtomico(fichero, valor) {
  const tmp = fichero + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(valor), { mode: 0o600 });
  try { fs.renameSync(tmp, fichero); } catch (e) { fs.copyFileSync(tmp, fichero); fs.unlinkSync(tmp); }
  try { fs.chmodSync(fichero, 0o600); } catch (e) { /* Windows/dev */ }
}

/* ---------- Caché local de socios ---------- */

let socios = [];              // [{ id, nombre, nfcUid, nfcId, qrUid, qrSeed, activo, hasta, birthdate, gym }]
const porUid = new Map();     // UID físico de la pulsera → socio (paso 1: NFC)
const porNfcId = new Map();   // id legado 'NFC-XXXX' → socio
const porQrUid = new Map();   // identificador del QR → socio (SOLO para validar el QR dinámico)
let etagSocios = null;
let sincronizando = false;
let ultimaSyncOk = 0;

function indexar() {
  porUid.clear(); porNfcId.clear(); porQrUid.clear();
  for (const s of socios) {
    if (s.nfcUid) porUid.set(String(s.nfcUid), s);
    if (s.nfcId) porNfcId.set(s.nfcId, s);
    // Compatibilidad con cachés antiguas (antes el prefijo del QR era el UID físico)
    const q = s.qrUid || s.nfcUid;
    if (q && s.qrSeed) porQrUid.set(String(q), s);
  }
}

function guardarCache() {
  try { escribirJsonAtomico(cfg.CACHE_FICHERO, { version: 2, generado: Date.now(), etag: etagSocios, socios }); }
  catch (e) { log('No se pudo guardar la caché:', e.message); }
}

/* Tolerante con el formato antiguo (array plano) y el nuevo ({version:2, socios}). */
function cargarCacheDisco() {
  try {
    const crudo = JSON.parse(fs.readFileSync(cfg.CACHE_FICHERO, 'utf8'));
    if (Array.isArray(crudo)) { socios = crudo; }
    else if (crudo && Array.isArray(crudo.socios)) { socios = crudo.socios; etagSocios = crudo.etag || null; }
    else socios = [];
    indexar();
    log(`Caché local cargada: ${socios.length} socios con carnet.`);
  } catch (e) { socios = []; }
}

/* Descarga los socios de la web y refresca la caché. Si falla, se sigue con la
   caché en disco (el torno debe funcionar aunque la web esté caída).
   Usa el endpoint del torno (Bearer) con ETag: si nada cambió → 304 sin coste. */
async function sincronizar() {
  if (sincronizando) return;
  sincronizando = true;
  try {
    const cab = etagSocios ? { 'If-None-Match': etagSocios } : {};
    const r = await pedir('GET', `${cfg.WEB}/api/torno/socios`, null, 0, cab);
    if (r.status === 401 || r.status === 403) {
      log(`TOKEN DEL TORNO RECHAZADO por la web (HTTP ${r.status}). Revisa MSD_TOKEN_TORNO en /etc/acceso-torno.env. Se sigue con la caché (${socios.length} socios).`);
      return;
    }
    if (r.status === 304) { ultimaSyncOk = Date.now(); await vaciarCola(); return; }
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    ultimaSyncOk = Date.now();
    // La web responde: aprovechamos para reenviar los accesos que quedaron en cola.
    await vaciarCola();
    const datos = JSON.parse(r.cuerpo);
    if (!datos || datos.version !== 2 || !Array.isArray(datos.socios)) throw new Error('formato de socios no reconocido');
    // Desfase de reloj: el servidor manda `generado`; si la Pi va muy desviada, aviso.
    if (typeof datos.generado === 'number') {
      const desfase = Date.now() - datos.generado;
      if (Math.abs(desfase) > 20000) log(`AVISO: el reloj de la Pi va ${Math.round(desfase / 1000)} s ${desfase > 0 ? 'adelantado' : 'atrasado'} respecto a la web. Revisa NTP (los QR dependen de la hora).`);
    }
    const nuevos = datos.socios.map((s) => ({
      id: String(s.id), nombre: s.nombre,
      nfcUid: s.nfcUid ? String(s.nfcUid) : null,
      nfcId: s.nfcId || null,
      qrUid: s.qrUid ? String(s.qrUid) : null,
      qrSeed: s.qrSeed || null,
      activo: s.activo === true,
      hasta: String(s.hasta || '1970-01-01'),
      birthdate: s.birthdate || '',
      gym: s.gym || null,
      // Recibo devuelto (domiciliación): dentro del plazo se AVISA; pasado `vence` (ms), se DENIEGA
      impago: (s.impago && typeof s.impago.vence === 'number') ? { desde: s.impago.desde || 0, vence: s.impago.vence } : null
    }));
    // Salvaguarda: si la web devuelve 0 socios pero ya teníamos caché, la
    // conservamos (un vaciado temporal de la web no debe dejar a nadie fuera).
    if (nuevos.length === 0 && socios.length > 0) {
      log(`La web devolvió 0 socios; se conserva la caché anterior (${socios.length}).`);
      return;
    }
    socios = nuevos;
    etagSocios = (r.cabeceras && r.cabeceras.etag) || null;
    indexar();
    guardarCache();
    log(`Sincronizados ${socios.length} socios con carnet desde la web.`);
  } catch (e) {
    log(`Sin conexión con la web ${cfg.WEB} (${e.message}); se sigue con la caché local (${socios.length} socios).`);
  } finally {
    sincronizando = false;
    if (ultimaSyncOk && Date.now() - ultimaSyncOk > 30 * 60e3) log('AVISO: llevo más de 30 min sin poder sincronizar con la web.');
  }
}

/* ---------- Validación (misma lógica que la web) ---------- */

function validar(ident, metodo, direccion) {
  const u = porUid.get(ident) || porNfcId.get(ident);
  if (!u) return { usuarioId: null, resultado: 'denegado', motivo: 'Carnet no reconocido', direccion: direccion === 'salida' ? 'salida' : 'entrada', raw: ident, metodo };
  return validarSocio(u, metodo, direccion, ident);
}

/* Reglas de acceso para un socio ya identificado (mismas que el servidor):
   salida siempre; entrada exige abono activo, en vigor y edad mínima.
   La hora de gimnasio asignada solo AVISA (el torno da paso a todo el complejo:
   pistas, clases, recepción), salvo MSD_GYM_MODO=denegar. */
function validarSocio(u, metodo, direccion, raw) {
  const dir = direccion === 'salida' ? 'salida' : 'entrada';
  const base = { usuarioId: u.id, direccion: dir, raw, metodo, nombre: u.nombre, avisos: [] };
  if (dir === 'salida') return Object.assign(base, { resultado: 'ok', motivo: 'Salida registrada' });
  if (!u.activo) return Object.assign(base, { resultado: 'denegado', motivo: 'Abono dado de baja' });
  if (u.hasta < hoy()) return Object.assign(base, { resultado: 'denegado', motivo: `Abono caducado el ${u.hasta}` });
  const edad = edadDe(u.birthdate);
  if (edad !== null && edad < cfg.EDAD_MINIMA) return Object.assign(base, { resultado: 'denegado', motivo: `Acceso a partir de ${cfg.EDAD_MINIMA} años` });
  // Recibo devuelto por el banco: el servidor manda el momento `vence` (fin del
  // plazo que fija el admin). Dentro del plazo se avisa; vencido, se deniega.
  if (u.impago && typeof u.impago.vence === 'number') {
    if (Date.now() > u.impago.vence) return Object.assign(base, { resultado: 'denegado', motivo: 'Recibo devuelto sin pagar' });
    base.avisos.push('Recibo devuelto: pendiente de pago');
  }
  if (u.gym && u.gym.franja) {
    const p = partesLocales(new Date());
    const ahoraMin = Number(p.hour) * 60 + Number(p.minute);
    const [hi, mi] = u.gym.franja.split(':').map(Number);
    const [hf, mf] = String(u.gym.fin || '').split(':').map(Number);
    const ini = hi * 60 + mi - 15, fin = (Number.isFinite(hf) ? hf * 60 + mf : ini + 75);
    if (ahoraMin < ini || ahoraMin > fin) {
      const aviso = `Fuera de su hora de gimnasio (${u.gym.franja}–${u.gym.fin || '?'})`;
      if (cfg.GYM_MODO === 'denegar') return Object.assign(base, { resultado: 'denegado', motivo: aviso });
      base.avisos.push(aviso);
    }
  }
  return Object.assign(base, { resultado: 'ok', motivo: 'Abono en vigor' });
}

/* Decide qué es lo leído y lo valida ("match-first", igual que la web):
   1) tarjeta conocida → NFC, 2) token dinámico numérico → QR, 3) numérico
   desconocido → tarjeta no reconocida, 4) texto raro → ilegible. */
function procesarLectura(texto, direccion) {
  const v = String(texto).trim();
  if (!v) return null;

  // 1) Tarjeta/pulsera física conocida (su UID va tal cual).
  if (porUid.get(v) || porNfcId.get(v)) return validar(v, 'nfc', direccion);

  // 2) Token dinámico numérico (QR rotatorio del carnet). El prefijo es el
  //    identificador PROPIO del QR (qrUid), no el UID físico de la pulsera: un
  //    QR con el UID desnudo no abre, y el UID físico nunca se muestra en la app.
  if (token.esDinamico(v)) {
    const r = token.validar(v, (uid) => {
      const s = porQrUid.get(uid);
      return s && s.qrSeed ? s.qrSeed : null;
    });
    const s = r.uid ? porQrUid.get(r.uid) : null;
    if (r.ok && s) return validarSocio(s, 'qr', direccion, v);
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

/* ---------- Registro del acceso en la web (con cola offline) ----------
   Si la web no responde (WiFi/internet caído), el acceso se guarda en una cola
   en disco y se reenvía cuando la web vuelva. Así no se pierde ningún paso
   aunque la red falle: la gente sigue entrando y todo queda registrado. */

const COLA_FICHERO = process.env.MSD_COLA || require('path').join(__dirname, 'cola-accesos.json');
let cola = [];

function cargarCola() {
  try { cola = JSON.parse(fs.readFileSync(COLA_FICHERO, 'utf8')); if (!Array.isArray(cola)) cola = []; }
  catch (e) { cola = []; }
  if (cola.length) log(`Cola de accesos pendientes de enviar: ${cola.length}.`);
}
function guardarCola() {
  try { escribirJsonAtomico(COLA_FICHERO, cola); }
  catch (e) { log('No se pudo guardar la cola de accesos:', e.message); }
}

/* Envía un evento al endpoint del torno. Cualquier 2xx es éxito (201 nuevo,
   200 ya existía = reenvío idempotente). Lanza con `reintentable` según el
   fallo: red/timeout/5xx/401/429 → reintentar; otro 4xx → descartar. */
async function enviarEvento(evento) {
  let r;
  try { r = await pedir('POST', `${cfg.WEB}/api/torno/acceso`, { evento }); }
  catch (e) { throw Object.assign(new Error(e.message), { reintentable: true }); }
  if (r.status >= 200 && r.status < 300) return;
  const reintentable = r.status >= 500 || r.status === 401 || r.status === 403 || r.status === 429 || r.status === 404;
  throw Object.assign(new Error('HTTP ' + r.status + ' ' + (r.cuerpo || '').slice(0, 120)), { reintentable });
}

async function registrar(res) {
  // ts = momento REAL del paso (se conserva aunque se reenvíe más tarde); id
  // único para que los reenvíos no dupliquen en el servidor.
  const evento = {
    id: require('crypto').randomUUID().replace(/-/g, ''),
    ts: Date.now(),
    usuarioId: res.usuarioId, metodo: res.metodo, resultado: res.resultado,
    motivo: res.motivo, direccion: res.direccion, raw: res.raw,
    avisos: res.avisos || []
  };
  try {
    await enviarEvento(evento);
  } catch (e) {
    if (e.reintentable === false) { log(`  ! la web rechazó el acceso (${e.message}); no se reintenta.`); return; }
    if (cola.length >= cfg.COLA_MAX) { cola.shift(); log('  ! cola llena: se descarta el acceso más antiguo.'); }
    cola.push(evento);
    guardarCola();
    log(`  ! web no disponible: acceso ENCOLADO para reenviar (${cola.length} en cola).`);
  }
}

/* Reenvía los accesos encolados. Se llama al arrancar y tras cada sync exitosa.
   Los que llegan mientras se vacía se conservan (no se pierden por la carrera). */
let vaciando = false;
async function vaciarCola() {
  if (!cola.length || vaciando) return;
  vaciando = true;
  try {
    const pendientes = cola.slice();
    const quedan = [];
    for (const evento of pendientes) {
      try { await enviarEvento(evento); }
      catch (e) { if (e.reintentable !== false) quedan.push(evento); else log(`  ! evento de la cola rechazado (${e.message}); se descarta.`); }
    }
    cola = quedan.concat(cola.slice(pendientes.length));   // los añadidos durante el vaciado
    guardarCola();
    const enviados = pendientes.length - quedan.length;
    if (enviados > 0) log(`Reenviados ${enviados} accesos de la cola.${cola.length ? ' Quedan ' + cola.length + '.' : ''}`);
  } finally { vaciando = false; }
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
  cargarCola();
  await sincronizar();
  setInterval(sincronizar, cfg.SYNC_MS);
  for (const lector of cfg.LECTORES) conectarLector(lector);
  log(`Escuchando ${cfg.LECTORES.map((l) => `${l.direccion}@${l.host}:${l.puerto}`).join('  ')}`);
}

principal();
