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

/* ---------- Estado persistente ---------- */

let estado = {};
try {
  estado = JSON.parse(fs.readFileSync(FICHERO_DATOS, 'utf8'));
  if (!estado || typeof estado !== 'object' || Array.isArray(estado)) estado = {};
} catch (e) { estado = {}; }

let temporizadorGuardado = null;
function persistir() {
  clearTimeout(temporizadorGuardado);
  temporizadorGuardado = setTimeout(() => {
    fs.mkdir(path.dirname(FICHERO_DATOS), { recursive: true }, (errDir) => {
      if (errDir) return console.error('No se pudo crear data/:', errDir.message);
      fs.writeFile(FICHERO_DATOS, JSON.stringify(estado), (err) => {
        if (err) console.error('No se pudo guardar el estado:', err.message);
      });
    });
  }, 250);
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

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ruta = decodeURIComponent(url.pathname);

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

  /* Reinicio del modo demo: vacía el estado central */
  if (ruta === '/api/reiniciar' && req.method === 'POST') {
    estado = {};
    persistir();
    res.writeHead(204); res.end();
    return;
  }

  if (ruta === '/api/eventos' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive'
    });
    res.write(': conectado\n\n');
    oyentes.add(res);
    const latido = setInterval(() => {
      try { res.write(': latido\n\n'); } catch (e) { /* se limpia en close */ }
    }, 25000);
    req.on('close', () => { clearInterval(latido); oyentes.delete(res); });
    return;
  }

  if (ruta.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"no existe"}');
    return;
  }

  /* --- Estáticos --- */

  let pedida = ruta === '/' ? '/index.html' : ruta;
  const fichero = path.normalize(path.join(RAIZ, pedida));
  if (!fichero.startsWith(RAIZ) || pedida.startsWith('/data/')) {
    res.writeHead(403); res.end('403'); return;
  }
  fs.readFile(fichero, (err, contenido) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, {
      'Content-Type': TIPOS[path.extname(fichero).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(contenido);
  });
}).listen(PUERTO, () => {
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
