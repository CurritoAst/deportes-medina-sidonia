/* ==========================================================================
   Deportes · Medina Sidonia — acceso a la base de datos (MySQL/MariaDB)
   Un único pool para toda la aplicación, configurado según el diseño:
     · timezone 'Z' + SET time_zone='+00:00' por conexión → los DATETIME viajan
       en UTC y llegan como Date; los DATE llegan como 'YYYY-MM-DD' (texto),
       que es lo que comparamos en Node (días de Europe/Madrid).
     · namedPlaceholders → consultas legibles con :nombre.
   Helpers: consulta(), uno(), enTransaccion() con reintento único ante deadlock.
   Si no hay variables MSD_DB_*, `disponible()` es false y el servidor sigue en
   el modo fichero legado (desarrollo local sin BD).
   ========================================================================== */

'use strict';

let pool = null;

function configurada() {
  return !!(process.env.MSD_DB_HOST || process.env.MSD_DB_NAME);
}

function obtenerPool() {
  if (pool) return pool;
  const mysql = require('mysql2/promise');   // solo se carga si hay BD configurada
  pool = mysql.createPool({
    host: process.env.MSD_DB_HOST || 'localhost',
    port: Number(process.env.MSD_DB_PORT || 3306),
    user: process.env.MSD_DB_USER,
    password: process.env.MSD_DB_PASSWORD,
    database: process.env.MSD_DB_NAME,
    waitForConnections: true,
    connectionLimit: Number(process.env.MSD_DB_POOL || 10),
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: ['DATE'],         // DATE como 'YYYY-MM-DD'; DATETIME como Date (UTC)
    namedPlaceholders: true,
    supportBigNumbers: false,
    decimalNumbers: true           // DECIMAL como number (precios)
  });
  pool.on('connection', (c) => { c.query("SET time_zone = '+00:00'"); });
  return pool;
}

/* SELECT/INSERT/UPDATE con parámetros (array posicional o objeto nombrado). */
async function consulta(sql, params) {
  const [filas] = await obtenerPool().query(sql, params);
  return filas;
}
/* Primera fila o null. */
async function uno(sql, params) {
  const filas = await consulta(sql, params);
  return Array.isArray(filas) && filas.length ? filas[0] : null;
}

/* Ejecuta fn(conexion) dentro de una transacción. Reintenta UNA vez si la BD
   reporta deadlock (ER_LOCK_DEADLOCK) o timeout de bloqueo. */
async function enTransaccion(fn, intentos) {
  const con = await obtenerPool().getConnection();
  try {
    await con.beginTransaction();
    const r = await fn(con);
    await con.commit();
    return r;
  } catch (e) {
    try { await con.rollback(); } catch (e2) { /* ignora */ }
    if ((e.code === 'ER_LOCK_DEADLOCK' || e.code === 'ER_LOCK_WAIT_TIMEOUT') && (intentos || 0) < 1) {
      con.release();
      return enTransaccion(fn, (intentos || 0) + 1);
    }
    throw e;
  } finally {
    try { con.release(); } catch (e) { /* ya liberada */ }
  }
}

/* ¿Es un choque de UNIQUE? (para traducir a 409). */
const esDuplicado = (e) => !!e && e.code === 'ER_DUP_ENTRY';

async function cerrar() {
  if (pool) { try { await pool.end(); } catch (e) { /* ignora */ } pool = null; }
}

module.exports = { configurada, obtenerPool, consulta, uno, enTransaccion, esDuplicado, cerrar };
