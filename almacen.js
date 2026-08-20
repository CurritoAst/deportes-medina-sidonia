/* ==========================================================================
   Deportes · Medina Sidonia — almacén del estado compartido
   Guarda el diccionario de estado (las claves msd_*) en uno de dos sitios:

     · MySQL / MariaDB  → si hay credenciales (variables MSD_DB_*). Es lo que
       trae Plesk; se ve y gestiona por phpMyAdmin y entra en los backups.
     · Fichero JSON     → si NO hay credenciales (desarrollo local en el PC,
       o un host con disco). Es el comportamiento de siempre (data/estado.json).

   Modelo CLAVE-VALOR: una sola tabla `estado(clave, valor)` que refleja el mismo
   diccionario que guardaba el fichero. Cada `valor` es el JSON de esa clave
   (msd_reservas, msd_accesos, msd_socios, …). Así el front-end y el torno NO
   cambian: siguen usando /api/estado igual que antes.

   Interfaz común de un almacén:
     · tipo               'mysql' | 'fichero'
     · async cargar()     → devuelve el objeto estado { clave: valorString }
     · async volcar(est)  → persiste el objeto entero (upsert + borra sobrantes)
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

/* ---------- Almacén en fichero JSON (por defecto / local) ---------- */
function crearAlmacenFichero(fichero) {
  return {
    tipo: 'fichero',
    destino: fichero,
    async cargar() {
      try {
        const est = JSON.parse(fs.readFileSync(fichero, 'utf8'));
        if (!est || typeof est !== 'object' || Array.isArray(est)) return {};
        return est;
      } catch (e) { return {}; }
    },
    async volcar(estado) {
      await fs.promises.mkdir(path.dirname(fichero), { recursive: true });
      await fs.promises.writeFile(fichero, JSON.stringify(estado));
    },
    async cerrar() { /* nada que cerrar */ }
  };
}

/* ---------- Almacén en MySQL / MariaDB (Plesk) ---------- */
function crearAlmacenMysql() {
  // Se carga aquí para que en local (sin BD) NO haga falta instalar mysql2.
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({
    host: process.env.MSD_DB_HOST || 'localhost',
    port: Number(process.env.MSD_DB_PORT || 3306),
    user: process.env.MSD_DB_USER,
    password: process.env.MSD_DB_PASSWORD,
    database: process.env.MSD_DB_NAME,
    waitForConnections: true,
    connectionLimit: 4,
    charset: 'utf8mb4',
    // El estado se guarda como texto JSON; no queremos conversiones raras.
    dateStrings: true
  });

  async function asegurarTabla() {
    await pool.query(
      'CREATE TABLE IF NOT EXISTS estado (' +
      '  clave VARCHAR(64) NOT NULL PRIMARY KEY,' +
      '  valor MEDIUMTEXT NOT NULL' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
  }

  return {
    tipo: 'mysql',
    destino: (process.env.MSD_DB_NAME || '') + '@' + (process.env.MSD_DB_HOST || 'localhost'),
    async cargar() {
      await asegurarTabla();
      const [filas] = await pool.query('SELECT clave, valor FROM estado');
      const estado = {};
      for (const f of filas) estado[f.clave] = f.valor;
      return estado;
    },
    async volcar(estado) {
      const claves = Object.keys(estado);
      const con = await pool.getConnection();
      try {
        await con.beginTransaction();
        if (claves.length === 0) {
          await con.query('DELETE FROM estado');
        } else {
          // Inserta/actualiza todas las claves actuales (parametrizado: sin inyección).
          const valores = claves.map((c) => [c, estado[c]]);
          await con.query(
            'INSERT INTO estado (clave, valor) VALUES ? ' +
            'ON DUPLICATE KEY UPDATE valor = VALUES(valor)',
            [valores]
          );
          // Borra las claves que ya no están en el estado (p. ej. tras reiniciar).
          await con.query('DELETE FROM estado WHERE clave NOT IN (?)', [claves]);
        }
        await con.commit();
      } catch (e) {
        try { await con.rollback(); } catch (e2) { /* ignora */ }
        throw e;
      } finally {
        con.release();
      }
    },
    async cerrar() { try { await pool.end(); } catch (e) { /* ignora */ } }
  };
}

/* Elige el almacén: MySQL si hay credenciales, si no fichero. Si MySQL está
   configurado pero mysql2 no está instalado, avisa y cae al fichero para no
   dejar la web caída. */
function crearAlmacen(opciones) {
  const fichero = (opciones && opciones.ficheroDatos) || path.join(__dirname, 'data', 'estado.json');
  const hayBd = !!(process.env.MSD_DB_HOST || process.env.MSD_DB_NAME);
  if (hayBd) {
    try {
      return crearAlmacenMysql();
    } catch (e) {
      console.error('[BD] MySQL configurado pero no disponible (' + e.message + '). Se usa el fichero local.');
    }
  }
  return crearAlmacenFichero(fichero);
}

module.exports = { crearAlmacen, crearAlmacenFichero, crearAlmacenMysql };
