'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { sentencias, listarFicheros } = require('../migrar.js');

test('sentencias: parte por ; a fin de línea e ignora comentarios --', () => {
  const sql = `-- comentario
CREATE TABLE a (
  id INT -- esto no es un separador; sigue
);
INSERT INTO a VALUES (1);
-- otro
INSERT INTO a VALUES (2);
`;
  const s = sentencias(sql);
  assert.equal(s.length, 3);
  assert.match(s[0], /^CREATE TABLE a/);
  assert.match(s[1], /^INSERT INTO a VALUES \(1\)/);
  assert.match(s[2], /^INSERT INTO a VALUES \(2\)/);
});

test('los ficheros de migraciones están numerados y ordenados sin huecos', () => {
  const lista = listarFicheros();
  assert.ok(lista.length >= 2, 'debe haber al menos 001 y 002');
  lista.forEach((m, i) => assert.equal(m.version, i + 1, `versión ${m.nombre} fuera de secuencia`));
});

test('001_esquema.sql crea todas las tablas del diseño y 002 no toca usuarios', () => {
  const sql001 = fs.readFileSync(path.join(__dirname, '..', 'migraciones', '001_esquema.sql'), 'utf8');
  const tablas = ['migraciones', 'usuarios', 'sesiones', 'tokens_correo', 'abonos', 'abono_movimientos', 'carnets', 'accesos',
    'instalaciones', 'pistas', 'clases', 'reservas', 'bloqueos', 'inscripciones_clase', 'gimnasio_franjas',
    'gimnasio_inscripciones', 'notificaciones', 'registro_actividad', 'ajustes', 'correos_salida'];
  for (const t of tablas) assert.match(sql001, new RegExp(`CREATE TABLE (IF NOT EXISTS )?${t} \\(`), `falta tabla ${t}`);
  // qr_uid separado del UID físico (revisión de seguridad)
  assert.match(sql001, /qr_uid\s+CHAR\(10\)\s+NOT NULL/);
  assert.match(sql001, /UNIQUE KEY uq_carnets_qr_uid/);
  const sql002 = fs.readFileSync(path.join(__dirname, '..', 'migraciones', '002_semillas.sql'), 'utf8');
  assert.doesNotMatch(sql002, /INSERT INTO usuarios/i, '002 no debe insertar usuarios (sin datos personales)');
  assert.match(sql002, /'gimnasio',\s*'Gimnasio del Pabellón',\s*0,\s*90,\s*2\.50,\s*0\.00,\s*'sesión',\s*0/, 'gimnasio no reservable online');
  // cada sentencia del 002 se parsea
  assert.ok(sentencias(sql002).length >= 5);
});
