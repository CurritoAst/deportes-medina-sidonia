/* ==========================================================================
   Deportes · Medina Sidonia — migrador de esquema
   Aplica, en orden, los ficheros migraciones/NNN_nombre.sql que aún no estén
   registrados en la tabla `migraciones`. Cada fichero se ejecuta en UNA
   transacción (si algo falla, no queda a medias) y bajo un GET_LOCK para que
   dos arranques simultáneos no se pisen.

   Lo ejecuta server.js al arrancar (antes de escuchar) y también se puede
   lanzar a mano:  node migrar.js
   Si no hay BD configurada (sin MSD_DB_*), no hace nada.

   NOTA MariaDB/MySQL: el DDL (CREATE TABLE) hace commit implícito, así que la
   "transacción" protege de verdad las migraciones de DATOS (002 en adelante) y,
   para el DDL, el registro en `migraciones` va al final: si una CREATE falla,
   la versión no se anota y el siguiente arranque vuelve a intentarlo.
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const bd = require('./lib/bd');

const DIR = path.join(__dirname, 'migraciones');

function listarFicheros() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR)
    .filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: Number(f.slice(0, 3)), nombre: f.replace(/\.sql$/, ''), ruta: path.join(DIR, f) }));
}

/* Parte un .sql en sentencias (separador ';' al final de línea), ignorando
   comentarios '--'. Suficiente para nuestros ficheros (sin procedimientos). */
function sentencias(sql) {
  const sinComentarios = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  return sinComentarios.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s.length);
}

async function versionActual(con) {
  // La tabla puede no existir aún (antes de la 001)
  const t = await con.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'migraciones'");
  if (!t[0][0].n) return 0;
  const r = await con.query('SELECT COALESCE(MAX(version), 0) AS v FROM migraciones');
  return Number(r[0][0].v) || 0;
}

async function migrar(log) {
  log = log || (() => {});
  if (!bd.configurada()) { log('[migrar] sin BD configurada: nada que hacer'); return { aplicadas: [], version: 0 }; }
  const pool = bd.obtenerPool();
  const con = await pool.getConnection();
  const aplicadas = [];
  try {
    const lock = await con.query("SELECT GET_LOCK('msd_migraciones', 30) AS ok");
    if (!lock[0][0].ok) throw new Error('No se pudo obtener el lock de migraciones (otro arranque en curso)');
    let actual = await versionActual(con);
    for (const m of listarFicheros()) {
      if (m.version <= actual) continue;
      log(`[migrar] aplicando ${m.nombre}…`);
      const sql = fs.readFileSync(m.ruta, 'utf8');
      await con.beginTransaction();
      try {
        for (const s of sentencias(sql)) await con.query(s);
        await con.query('INSERT INTO migraciones (version, nombre) VALUES (?, ?)', [m.version, m.nombre]);
        await con.commit();
      } catch (e) {
        try { await con.rollback(); } catch (e2) { /* ignora */ }
        throw new Error(`Migración ${m.nombre} falló: ${e.message}`);
      }
      aplicadas.push(m.nombre);
      actual = m.version;
    }
    await con.query("SELECT RELEASE_LOCK('msd_migraciones')");
    return { aplicadas, version: actual };
  } finally {
    con.release();
  }
}

module.exports = { migrar, listarFicheros, sentencias };

if (require.main === module) {
  migrar(console.log)
    .then((r) => { console.log(`[migrar] esquema en versión ${r.version}; aplicadas: ${r.aplicadas.join(', ') || 'ninguna'}`); return bd.cerrar(); })
    .catch((e) => { console.error('[migrar] ERROR:', e.message); process.exit(1); });
}
