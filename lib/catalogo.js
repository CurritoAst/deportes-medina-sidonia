/* ==========================================================================
   Deportes · Medina Sidonia — catálogo de instalaciones/pistas (servidor)
   Espejo de js/data.js para el lado servidor (sin depender de globales del
   navegador). Al arrancar, server.js hace UPSERT de esto en las tablas
   `instalaciones` y `pistas`: nombre/duración/exterior/unidad/orden/reservable
   se actualizan desde aquí; el PRECIO y el SUPLEMENTO DE LUZ solo se insertan
   la primera vez y luego manda el panel (tabla), nunca se pisan.
   ========================================================================== */

'use strict';

const INSTALACIONES = [
  { id: 'padel',    nombre: 'Pádel',                  exterior: 1, duracionMin: 90, precio: 4,   suplementoLuz: 2, unidad: '90 min', reservableOnline: 1, orden: 1,
    pistas: [{ id: 'padel-1', nombre: 'Pádel Pista 1', orden: 1 }, { id: 'padel-2', nombre: 'Pádel Pista 2', orden: 2 }] },
  { id: 'tenis',    nombre: 'Tenis',                  exterior: 1, duracionMin: 60, precio: 3,   suplementoLuz: 2, unidad: 'hora',   reservableOnline: 1, orden: 2,
    pistas: [{ id: 'tenis-1', nombre: 'Pista de Tenis', orden: 1 }] },
  { id: 'futbol7',  nombre: 'Fútbol 7',               exterior: 1, duracionMin: 60, precio: 25,  suplementoLuz: 6, unidad: 'hora',   reservableOnline: 1, orden: 3,
    pistas: [{ id: 'futbol7-1', nombre: 'Fútbol 7 · Pista 1 (Cantina)', orden: 1 }, { id: 'futbol7-2', nombre: 'Fútbol 7 · Pista 2', orden: 2 }] },
  { id: 'pabellon', nombre: 'Pabellón Polideportivo', exterior: 0, duracionMin: 60, precio: 16,  suplementoLuz: 0, unidad: 'hora',   reservableOnline: 1, orden: 4,
    pistas: [{ id: 'pabellon-central', nombre: 'Pista del Pabellón', orden: 1 }] },
  { id: 'sala',     nombre: 'Salas del Pabellón',     exterior: 0, duracionMin: 60, precio: 8,   suplementoLuz: 0, unidad: 'hora',   reservableOnline: 1, orden: 5,
    pistas: [{ id: 'sala-1', nombre: 'Sala del Pabellón', orden: 1 }] },
  // El gimnasio NO se reserva online: se asigna hora presencialmente (gimnasio por horas).
  { id: 'gimnasio', nombre: 'Gimnasio del Pabellón',  exterior: 0, duracionMin: 90, precio: 2.5, suplementoLuz: 0, unidad: 'sesión', reservableOnline: 0, orden: 6,
    pistas: [{ id: 'gimnasio-sala', nombre: 'Gimnasio del Pabellón', orden: 1 }] }
];

/* Clases dirigidas: semilla INICIAL de la tabla `clases` (solo se inserta si no
   existe; después la edita el admin). Sin los contadores de simulación de la demo. */
const CLASES = [
  { id: 'pilates',       nombre: 'Pilates',                  lugar: 'Sala de actividades',    espacio: 'sala',     dias: 'Lunes y miércoles',          hora: '09:30 – 10:20', monitor: 'Lucía Barea',     aforo: 15, precioMes: 16, icono: 'i-personas', orden: 1 },
  { id: 'ciclo',         nombre: 'Ciclo indoor',             lugar: 'Sala de ciclo',          espacio: 'sala',     dias: 'Martes y jueves',            hora: '20:00 – 20:50', monitor: 'Raúl Benítez',    aforo: 20, precioMes: 18, icono: 'i-flash',    orden: 2 },
  { id: 'zumba',         nombre: 'Zumba',                    lugar: 'Pabellón cubierto',      espacio: 'pabellon', dias: 'Lunes y miércoles',          hora: '19:00 – 19:50', monitor: 'Marta Collantes', aforo: 25, precioMes: 15, icono: 'i-personas', orden: 3 },
  { id: 'gap',           nombre: 'GAP',                      lugar: 'Sala de actividades',    espacio: 'sala',     dias: 'Martes y jueves',            hora: '09:30 – 10:20', monitor: 'Lucía Barea',     aforo: 15, precioMes: 15, icono: 'i-flash',    orden: 4 },
  { id: 'yoga',          nombre: 'Yoga',                     lugar: 'Sala de actividades',    espacio: 'sala',     dias: 'Viernes',                    hora: '18:00 – 19:00', monitor: 'Carmen Aragón',   aforo: 15, precioMes: 12, icono: 'i-sol',      orden: 5 },
  { id: 'mantenimiento', nombre: 'Gimnasia de mantenimiento', lugar: 'Pabellón cubierto',     espacio: 'pabellon', dias: 'Lunes, miércoles y viernes', hora: '10:30 – 11:20', monitor: 'Paco Reyes',      aforo: 30, precioMes: 12, icono: 'i-personas', orden: 6 },
  { id: 'aerobic',       nombre: 'Aerobic-step',             lugar: 'Sala de actividades',    espacio: 'sala',     dias: 'Martes y jueves',            hora: '18:30 – 19:20', monitor: 'Marta Collantes', aforo: 15, precioMes: 15, icono: 'i-flash',    orden: 7 },
  { id: 'tonofit',       nombre: 'Tonofit',                  lugar: 'Sala del Pabellón',      espacio: 'sala',     dias: 'Lunes y miércoles',          hora: '20:00 – 20:50', monitor: 'Sergio Pantoja',  aforo: 22, precioMes: 18, icono: 'i-flash',    orden: 8 },
  { id: 'voleibol',      nombre: 'Voleibol',                 lugar: 'Pabellón Polideportivo', espacio: 'pabellon', dias: 'Sábados',                    hora: '10:00 – 11:15', monitor: 'Sergio Pantoja',  aforo: 18, precioMes: 14, icono: 'i-personas', orden: 9 },
  { id: 'baloncesto',    nombre: 'Escuela de baloncesto',    lugar: 'Pabellón cubierto',      espacio: 'pabellon', dias: 'Martes y jueves',            hora: '17:00 – 18:15', monitor: 'Andrés Macías',   aforo: 20, precioMes: 12, icono: 'i-personas', orden: 10 }
];

/* Ajustes por defecto (tabla `ajustes`, solo se insertan si no existen). */
const AJUSTES = {
  reserva_desde_dias: 0,        // desde hoy
  reserva_dias_ventana: 14,     // días de antelación (hoy DIAS_VISIBLES)
  abono_precio_mes: 18,
  aforo_max: 40,                // capacidad de la sala fitness
  edad_minima: 16,
  hora_luz: 19,                 // desde esta hora, suplemento de luz en exteriores
  horario_laborable: [9, 23],   // [apertura, cierre)
  horario_finde: [9, 21],
  max_reservas_futuras: 2,
  cancelacion_min_horas: 24
};

/* Franjas del gimnasio por horas (09:00..21:00, 1 h, capacidad 20). */
const GIMNASIO_FRANJAS = Array.from({ length: 13 }, (_, i) => ({ horaInicio: `${String(9 + i).padStart(2, '0')}:00:00`, duracionMin: 60, capacidad: 20 }));

const instalacion = (id) => INSTALACIONES.find((i) => i.id === id) || null;
const pista = (id) => { for (const i of INSTALACIONES) { const p = i.pistas.find((x) => x.id === id); if (p) return { ...p, instalacionId: i.id }; } return null; };

module.exports = { INSTALACIONES, CLASES, AJUSTES, GIMNASIO_FRANJAS, instalacion, pista };
