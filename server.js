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
  try {
    atender(req, res);
  } catch (e) {
    // Nunca dejar caer el proceso por una petición rara
    console.error('Error atendiendo', req.method, req.url, e.message);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); }
    try { res.end('{"error":"error interno"}'); } catch (e2) { /* ya cerrada */ }
  }
});

function atender(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let ruta;
  try { ruta = decodeURIComponent(url.pathname); }
  catch (e) { res.writeHead(400); res.end('400'); return; }   // p. ej. '/%' (URI malformada)

  /* --- API --- */

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
      claves: Object.keys(estado).length,
      node: process.version
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
  clearTimeout(cierre);
  process.exit(0);
}
process.on('SIGTERM', apagar);
process.on('SIGINT', apagar);

arrancar();
