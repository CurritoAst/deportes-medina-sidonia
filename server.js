/* ==========================================================================
   Deportes · Medina Sidonia — servidor local
   Node puro, sin dependencias. Hace dos cosas:
     1. Sirve los ficheros estáticos de la web y del panel.
     2. Expone una pequeña API de estado compartido con eventos en directo,
        para que varios dispositivos (móvil, recepción, panel) vean los
        mismos datos al momento.

   Uso:  node server.js   →  http://localhost:8137
   Los datos se guardan en data/estado.json.
   ========================================================================== */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { crearAlmacen, crearAlmacenFichero } = require('./almacen');
const bd = require('./lib/bd');
const { migrar } = require('./migrar');
const { crearRouter } = require('./lib/http');
const sesion = require('./lib/sesion');
const tornoAuth = require('./lib/torno-auth');
const limite = require('./lib/limite');
const correo = require('./lib/correo');
const authRutas = require('./lib/auth-rutas');
const abonosRutas = require('./lib/abonos-rutas');
const tornoRutas = require('./lib/torno-rutas');

/* ---------- API nueva (F2+): router con sesión en servidor ----------
   Convive con las rutas legadas de abajo hasta que cada pantalla migre. Solo se
   monta si hay BD (sin BD, en desarrollo local, la API nueva responde 503). */
const router = crearRouter({
  urlPublica: process.env.MSD_URL_PUBLICA || '',
  autenticarSesion: (req, res) => (bd.configurada() ? sesion.autenticar(req, res) : Promise.resolve(null)),
  autenticarTorno: (req) => Promise.resolve(tornoAuth.autenticar(req))
});
authRutas.montar(router);
authRutas.anadirExtras(abonosRutas.extrasUsuario);   // /api/auth/yo incluye el abono
/* Un acceso nuevo (torno o panel) se refleja también en el registro legado
   msd_accesos y se difunde por SSE, así el panel/monitor actuales lo ven en vivo
   hasta que migren a la API (F6). */
function difundirAcceso(ev) {
  try {
    let lista; try { lista = JSON.parse(estado.msd_accesos || '[]'); } catch (e) { lista = []; }
    if (!Array.isArray(lista)) lista = [];
    lista.unshift({ ts: ev.ts, usuarioId: ev.usuarioId, metodo: ev.metodo, resultado: ev.resultado, motivo: ev.motivo, direccion: ev.direccion, raw: ev.raw || '' , nombre: ev.nombre || null });
    estado.msd_accesos = JSON.stringify(lista.slice(0, 300));
    persistir();
    difundir('msd_accesos', estado.msd_accesos, null);
  } catch (e) { console.error('[difundirAcceso]', e.message); }
}
tornoRutas.montar(router, { difundirAcceso });
abonosRutas.montar(router, { difundirAcceso });

/* En local usa 8137; en un host (Render, Railway, Fly…) se toma el puerto que
   inyecta la plataforma por la variable PORT. */
const PUERTO = process.env.PORT || 8137;
const RAIZ = __dirname;
/* Carpeta de datos. En local es ./data; en un host con disco persistente basta
   con exportar MSD_DATA_DIR=/ruta/al/disco para que el estado sobreviva a
   reinicios y despliegues (p. ej. un disco de Render montado en /var/data). */
const DIR_DATOS = process.env.MSD_DATA_DIR || path.join(RAIZ, 'data');
const FICHERO_DATOS = path.join(DIR_DATOS, 'estado.json');

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.md': 'text/plain; charset=utf-8'
};

/* Claves que el servidor acepta sincronizar. La sesión y los datos de
   precarga del formulario son locales de cada dispositivo, nunca se comparten. */
const CLAVE_VALIDA = /^msd_[a-z0-9_]{1,40}$/;
const CLAVES_LOCALES = new Set(['msd_sesion', 'msd_usuario']);
const TAMANO_MAX = 400 * 1024; // por clave

/* ---------- Estado persistente (MySQL en Plesk, o fichero JSON en local) ---------- */

let almacen = crearAlmacen({ ficheroDatos: FICHERO_DATOS });
let estado = {};   // se rellena en arrancar(), antes de empezar a escuchar.
let ultimoErrorBd = null;   // último error de la BD (para /api/salud)
const bdConfigurada = !!(process.env.MSD_DB_HOST || process.env.MSD_DB_NAME);
let esquemaVersion = 0;     // versión del esquema relacional aplicada por migrar.js
let esquemaError = null;

/* Guardado con rebote (250 ms): agrupa ráfagas de cambios en una sola escritura.
   El cerrojo `guardando` evita que dos volcados se solapen (importante con la
   transacción de MySQL); si llega un cambio mientras se guarda, se reprograma. */
let temporizadorGuardado = null;
let guardando = false;
let repetirGuardado = false;
function persistir() {
  clearTimeout(temporizadorGuardado);
  temporizadorGuardado = setTimeout(volcar, 250);
}
function volcar() {
  if (guardando) { repetirGuardado = true; return; }
  guardando = true;
  Promise.resolve()
    .then(() => almacen.volcar(estado))
    .catch((err) => console.error(`No se pudo guardar el estado en ${almacen.tipo}:`, err.message))
    .then(() => {
      guardando = false;
      if (repetirGuardado) { repetirGuardado = false; persistir(); }
    });
}

/* ---------- Eventos en directo (SSE) ---------- */

const oyentes = new Set();

function difundir(clave, valor, cliente) {
  const datos = `data: ${JSON.stringify({ clave, valor, cliente })}\n\n`;
  for (const res of oyentes) {
    try { res.write(datos); } catch (e) { oyentes.delete(res); }
  }
}

/* ---------- Servidor ---------- */

/* Cabeceras de seguridad en TODAS las respuestas. */
const CABECERAS_SEGURIDAD = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin'
};

const servidor = http.createServer((req, res) => {
  for (const [k, v] of Object.entries(CABECERAS_SEGURIDAD)) res.setHeader(k, v);
  if (sesion.esHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  let ruta;
  try { ruta = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname); }
  catch (e) { res.writeHead(400); res.end('400'); return; }   // p. ej. '/%' (URI malformada)

  // 1) API nueva (router con sesión en servidor). Si la ruta es suya, la atiende
  //    él (incluidos 401/403/404 de /api/auth/*). Si no, sigue el flujo legado.
  if (ruta.startsWith('/api/auth/') || ruta.startsWith('/api/torno/') || ruta.startsWith('/api/mi/') || ruta.startsWith('/api/admin/') || ruta.startsWith('/api/monitor/') || ruta === '/api/aforo') {
    if (!bd.configurada()) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"La API de cuentas necesita base de datos (variables MSD_DB_*)."}'); return; }
    const ip = limite.ipCliente(req);
    if (!limite.comprobar('apiIp', ip).permitido) { res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' }); res.end('{"error":"Demasiadas peticiones","codigo":"LIMITE"}'); return; }
    router.despachar(req, res, ruta, { ip }).then((atendida) => {
      if (!atendida && !res.headersSent) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"no existe"}'); }
    }).catch((e) => {
      console.error('Error en router', req.method, ruta, e && e.message);
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"Error interno"}'); }
    });
    return;
  }

  try {
    atender(req, res, ruta);
  } catch (e) {
    // Nunca dejar caer el proceso por una petición rara
    console.error('Error atendiendo', req.method, req.url, e.message);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); }
    try { res.end('{"error":"error interno"}'); } catch (e2) { /* ya cerrada */ }
  }
});

function atender(req, res, ruta) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  /* --- API legada (clave-valor) — se irá vaciando en F2..F6 --- */

  if (ruta === '/api/estado' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(estado));
    return;
  }

  if (ruta.startsWith('/api/estado/') && req.method === 'PUT') {
    const clave = ruta.slice('/api/estado/'.length);
    if (!CLAVE_VALIDA.test(clave) || CLAVES_LOCALES.has(clave)) {
      res.writeHead(400); res.end('clave no permitida'); return;
    }
    let cuerpo = '';
    let excedido = false;
    req.on('data', (trozo) => {
      cuerpo += trozo;
      if (cuerpo.length > TAMANO_MAX) { excedido = true; req.destroy(); }
    });
    req.on('end', () => {
      if (excedido) return;
      try { JSON.parse(cuerpo); } catch (e) {
        res.writeHead(400); res.end('el valor debe ser JSON'); return;
      }
      estado[clave] = cuerpo;
      persistir();
      difundir(clave, cuerpo, url.searchParams.get('cliente') || null);
      res.writeHead(204); res.end();
    });
    return;
  }

  /* Reserva atómica: Node atiende de uno en uno, así que comprobar y escribir
     aquí es una sección crítica de verdad. Si dos móviles confirman el mismo
     tramo a la vez, el segundo recibe un 409 y un mensaje claro. */
  if (ruta === '/api/reservar' && req.method === 'POST') {
    let cuerpo = '';
    req.on('data', (t) => { cuerpo += t; if (cuerpo.length > 10000) req.destroy(); });
    req.on('end', () => {
      let datos;
      try { datos = JSON.parse(cuerpo); } catch (e) { datos = null; }
      const r = datos && datos.reserva;
      const valida = r && typeof r === 'object'
        && typeof r.id === 'string' && typeof r.pistaId === 'string'
        && /^\d{4}-\d{2}-\d{2}$/.test(String(r.fecha))
        && Number.isInteger(r.hora) && Number.isInteger(datos.finMin);
      if (!valida) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"peticion invalida"}'); return; }

      let lista, listaBloqueos;
      try { lista = JSON.parse(estado.msd_reservas || '[]'); } catch (e) { lista = []; }
      try { listaBloqueos = JSON.parse(estado.msd_bloqueos || '[]'); } catch (e) { listaBloqueos = []; }
      if (!Array.isArray(lista)) lista = [];
      if (!Array.isArray(listaBloqueos)) listaBloqueos = [];

      const cogida = lista.some((x) => x && x.pistaId === r.pistaId && x.fecha === r.fecha && x.hora === r.hora);
      const bloqueada = listaBloqueos.some((b) => b && b.pistaId === r.pistaId && b.fecha === r.fecha
        && r.hora < b.hastaMin && datos.finMin > b.desdeMin);
      if (cogida || bloqueada) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: bloqueada ? 'La pista está bloqueada en esa franja.' : 'Esa hora ya está cogida.' }));
        return;
      }
      lista.push(r);
      estado.msd_reservas = JSON.stringify(lista);
      persistir();
      difundir('msd_reservas', estado.msd_reservas, url.searchParams.get('cliente') || null);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  /* Registro de un acceso por el torno. Lo usa el servicio de acceso (acceso.js)
     que corre junto al torno. Añade el evento de forma atómica al histórico
     compartido y lo difunde por SSE, así el aforo y el registro se actualizan al
     momento en todos los dispositivos. La validación (abono, edad, firma del QR)
     la hace el servicio; aquí solo se comprueba la forma y se guarda. */
  if (ruta === '/api/acceso' && req.method === 'POST') {
    let cuerpo = '';
    let excedido = false;
    req.on('data', (t) => { cuerpo += t; if (cuerpo.length > 4000) { excedido = true; req.destroy(); } });
    req.on('end', () => {
      if (excedido) return;
      let datos;
      try { datos = JSON.parse(cuerpo); } catch (e) { datos = null; }
      const e = datos && datos.evento;
      const valido = e && typeof e === 'object'
        && (e.metodo === 'qr' || e.metodo === 'nfc')
        && (e.resultado === 'ok' || e.resultado === 'denegado')
        && (e.direccion === 'entrada' || e.direccion === 'salida')
        && typeof e.motivo === 'string' && e.motivo.length <= 120
        && (e.usuarioId === null || typeof e.usuarioId === 'string');
      if (!valido) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"evento invalido"}'); return; }

      let lista;
      try { lista = JSON.parse(estado.msd_accesos || '[]'); } catch (e2) { lista = []; }
      if (!Array.isArray(lista)) lista = [];
      const evento = {
        // Respeta la fecha del paso si viene (accesos reenviados desde la cola
        // offline conservan su momento real); si no, la del servidor.
        ts: (typeof e.ts === 'number' && e.ts > 0) ? e.ts : Date.now(),
        usuarioId: e.usuarioId, metodo: e.metodo,
        resultado: e.resultado, motivo: e.motivo, direccion: e.direccion,
        raw: typeof e.raw === 'string' ? e.raw.slice(0, 64) : ''
      };
      lista.unshift(evento);
      lista = lista.slice(0, 300);
      estado.msd_accesos = JSON.stringify(lista);
      persistir();
      difundir('msd_accesos', estado.msd_accesos, null);
      // F3: además queda en la tabla `accesos` (histórico real) si hay BD.
      if (bd.configurada() && esquemaVersion >= 1) {
        tornoRutas.registrarAcceso(evento, { origen: 'torno', dispositivo: 'legado' }).catch((err) => console.error('[accesos] tabla:', err.message));
      }
      res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, evento }));
    });
    return;
  }

  /* (El antiguo POST /api/reiniciar, que vaciaba TODO el estado sin ninguna
     autenticación, se ha eliminado: era un agujero de seguridad del prototipo.) */

  if (ruta === '/api/eventos' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      // Detrás de un proxy (nginx/Passenger en Plesk, Cloudflare…) hay que
      // desactivar el buffering o los eventos SSE no llegan en directo.
      'X-Accel-Buffering': 'no'
    });
    res.write(': conectado\n\n');
    oyentes.add(res);
    const latido = setInterval(() => {
      try { res.write(': latido\n\n'); } catch (e) { /* se limpia en close */ }
    }, 25000);
    req.on('close', () => { clearInterval(latido); oyentes.delete(res); });
    return;
  }

  /* Chequeo de salud: en qué modo persiste (mysql/fichero) y último error de BD.
     Útil para diagnosticar el despliegue. No expone datos sensibles. */
  if (ruta === '/api/salud' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      almacen: almacen.tipo,                 // 'mysql' | 'fichero'
      bd_configurada: bdConfigurada,         // ¿hay variables MSD_DB_*?
      bd_error: ultimoErrorBd,               // motivo si cayó al fichero
      esquema_version: esquemaVersion,       // migraciones aplicadas (0 = sin esquema relacional)
      esquema_error: esquemaError,
      claves: Object.keys(estado).length,
      node: process.version,
      pid: process.pid,
      // Configuración efectiva (solo banderas, nunca valores): ayuda a diagnosticar
      // el despliegue sin buscar la consola de Node.
      config: {
        registro_abierto: process.env.MSD_REGISTRO_ABIERTO !== '0',
        url_publica: !!process.env.MSD_URL_PUBLICA,
        smtp: !!process.env.MSD_SMTP_HOST,
        token_torno: tornoAuth.configurado(),
        bootstrap_admin_pendiente: !!(process.env.MSD_BOOTSTRAP_ADMIN_EMAIL && process.env.MSD_BOOTSTRAP_ADMIN_CLAVE),
        variables_msd: Object.keys(process.env).filter((k) => k.startsWith('MSD_')).sort().map((k) => (/PASS|CLAVE|TOKEN|PASSWORD/.test(k) ? k + '=***' : k))
      }
    }));
    return;
  }

  if (ruta.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"no existe"}');
    return;
  }

  /* --- Estáticos: SOLO por lista blanca ---
     Antes se servía cualquier fichero del repo (server.js, almacen.js, acceso/,
     *.md, .git…). Ahora solo lo que la web necesita; el resto → 404. */

  let pedida = ruta === '/' ? '/index.html' : ruta;
  if (!esEstaticoPermitido(pedida)) { res.writeHead(404); res.end('404'); return; }
  const fichero = path.normalize(path.join(RAIZ, pedida));
  if (!fichero.startsWith(RAIZ)) { res.writeHead(404); res.end('404'); return; }
  fs.readFile(fichero, (err, contenido) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, {
      'Content-Type': TIPOS[path.extname(fichero).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(contenido);
  });
}

// Una promesa rechazada sin capturar no debe tumbar el servidor (Passenger lo
// reiniciaría y se perderían las conexiones SSE).
process.on('unhandledRejection', (e) => console.error('Promesa sin capturar:', e && e.message ? e.message : e));

/* Lista blanca de estáticos: páginas, css/, js/ (sin los de prueba/demo), iconos,
   manifest y service worker. Todo lo demás (código de servidor, acceso/, data/,
   documentos .md, .git, node_modules…) no se sirve. */
const PAGINAS = new Set(['/index.html', '/admin.html', '/legal.html', '/accesibilidad.html', '/dossier.html']);
const RAIZ_OK = new Set(['/manifest.webmanifest', '/sw.js', '/icono.svg', '/icono-180.png']);
const JS_PROHIBIDOS = new Set(['/js/demo.js', '/js/qr-prueba.js']);
function esEstaticoPermitido(p) {
  if (p.includes('..') || p.includes('\0')) return false;
  if (PAGINAS.has(p) || RAIZ_OK.has(p)) return true;
  if (p.startsWith('/css/') && p.endsWith('.css')) return true;
  if (p.startsWith('/js/') && p.endsWith('.js') && !JS_PROHIBIDOS.has(p)) return true;
  return false;
}

/* Carga el estado del almacén (MySQL o fichero) y SOLO entonces empieza a
   escuchar, para no atender peticiones con el estado a medio cargar. Si MySQL
   estaba configurado pero falla al cargar, cae al fichero local para no dejar
   la web caída. */
async function arrancar() {
  // 1) Esquema relacional: aplica las migraciones pendientes ANTES de escuchar.
  //    Si falla, la web sigue arrancando con el almacén legado (no se cae), y
  //    /api/salud muestra el error para diagnosticarlo.
  if (bd.configurada()) {
    try {
      const r = await migrar((m) => console.log(m));
      esquemaVersion = r.version;
      if (r.aplicadas.length) console.log(`[BD] Migraciones aplicadas: ${r.aplicadas.join(', ')} (esquema v${r.version}).`);
      else console.log(`[BD] Esquema relacional en versión ${r.version}.`);
    } catch (e) {
      esquemaError = e.message;
      console.error('[BD] Error aplicando migraciones:', e.message);
    }
    // Primer admin por variables de entorno (solo si no hay ninguno) y bucle de
    // correos pendientes + purga de sesiones caducadas cada hora.
    if (!esquemaError && esquemaVersion >= 1) {
      try { await authRutas.bootstrapAdmin((m) => console.log(m)); } catch (e) { console.error('[bootstrap]', e.message); }
      correo.arrancarBucle();
      setInterval(() => sesion.purgar().catch(() => {}), 3600e3).unref();
      if (!process.env.MSD_URL_PUBLICA) console.warn('[config] Falta MSD_URL_PUBLICA: los enlaces de los correos saldrán con http://localhost:8137.');
      if (correo.modoDev()) console.warn('[correo] Sin MSD_SMTP_HOST: los correos NO se envían, se vuelcan a consola y a correos-salientes.log.');
    }
  }
  // 2) Estado legado (clave-valor) — sigue siendo la fuente de la web hasta que
  //    las fases F2..F6 muevan cada pantalla a las tablas nuevas.
  try {
    estado = await almacen.cargar();
    console.log(`[BD] Estado cargado desde ${almacen.tipo} (${almacen.destino}): ${Object.keys(estado).length} claves.`);
  } catch (e) {
    ultimoErrorBd = e.message;
    console.error(`[BD] No se pudo cargar desde ${almacen.tipo} (${e.message}). Se continúa con el fichero local.`);
    almacen = crearAlmacenFichero(FICHERO_DATOS);
    estado = await almacen.cargar();
  }
  servidor.listen(PUERTO, () => {
    const redes = [];
    const ifaces = require('os').networkInterfaces();
    for (const lista of Object.values(ifaces)) {
      for (const i of lista || []) {
        if (i.family === 'IPv4' && !i.internal) redes.push(i.address);
      }
    }
    console.log(`Deportes Medina Sidonia en marcha:`);
    console.log(`  · En este equipo:  http://localhost:${PUERTO}`);
    redes.forEach((ip) => console.log(`  · Desde el móvil:  http://${ip}:${PUERTO}  (misma wifi)`));
  });
}

/* Apagado ordenado: cuando Passenger/systemd recicla el proceso (SIGTERM) o se
   corta con Ctrl+C (SIGINT), volcamos el último cambio pendiente (el rebote de
   250 ms podría no haber saltado) y cerramos la conexión con la BD. */
let apagando = false;
async function apagar() {
  if (apagando) return;
  apagando = true;
  clearTimeout(temporizadorGuardado);
  const cierre = setTimeout(() => process.exit(0), 3000);   // por si algo se cuelga
  try { await almacen.volcar(estado); } catch (e) { console.error('Volcado final falló:', e.message); }
  try { await almacen.cerrar(); } catch (e) { /* ignora */ }
  try { await bd.cerrar(); } catch (e) { /* ignora */ }
  clearTimeout(cierre);
  process.exit(0);
}
process.on('SIGTERM', apagar);
process.on('SIGINT', apagar);

arrancar();
