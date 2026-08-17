/* ==========================================================================
   Deportes · Medina Sidonia — datos de instalaciones y clases dirigidas
   Datos de demostración basados en el Complejo Deportivo Prado de la Feria.
   ========================================================================== */

const INSTALACIONES = [
  {
    id: 'padel',
    nombre: 'Pádel',
    icono: 'i-padel',
    detalle: 'Pistas de cristal con césped artificial',
    exterior: true,          // aplica suplemento de luz desde las 19:00
    duracionMin: 90,
    precio: 4,
    suplementoLuz: 2,
    unidad: '90 min',
    pistas: [
      { id: 'padel-1', nombre: 'Pádel Pista 1' },
      { id: 'padel-2', nombre: 'Pádel Pista 2' }
    ]
  },
  {
    id: 'tenis',
    nombre: 'Tenis',
    icono: 'i-tenis',
    detalle: 'Superficie rápida, al aire libre',
    exterior: true,
    duracionMin: 60,
    precio: 3,
    suplementoLuz: 2,
    unidad: 'hora',
    pistas: [
      { id: 'tenis-1', nombre: 'Pista de Tenis' }
    ]
  },
  {
    id: 'futbol7',
    nombre: 'Fútbol 7',
    icono: 'i-futbol',
    detalle: 'Césped artificial, dos campos',
    exterior: true,
    duracionMin: 60,
    precio: 25,
    suplementoLuz: 6,
    unidad: 'hora',
    pistas: [
      { id: 'futbol7-1', nombre: 'Fútbol 7 · Pista 1 (Cantina)' },
      { id: 'futbol7-2', nombre: 'Fútbol 7 · Pista 2' }
    ]
  },
  {
    id: 'pabellon',
    nombre: 'Pabellón Polideportivo',
    icono: 'i-pabellon',
    detalle: 'Fútbol sala, baloncesto y bádminton',
    exterior: false,
    duracionMin: 60,
    precio: 16,
    suplementoLuz: 0,
    unidad: 'hora',
    pistas: [
      { id: 'pabellon-central', nombre: 'Pista del Pabellón' }
    ]
  },
  {
    id: 'sala',
    nombre: 'Salas del Pabellón',
    icono: 'i-personas',
    detalle: 'Salas de actividades para grupos',
    exterior: false,
    duracionMin: 60,
    precio: 8,
    suplementoLuz: 0,
    unidad: 'hora',
    pistas: [
      { id: 'sala-1', nombre: 'Sala del Pabellón' }
    ]
  },
  {
    id: 'gimnasio',
    nombre: 'Gimnasio del Pabellón',
    icono: 'i-gimnasio',
    detalle: 'Cardio y musculación, acceso por torno',
    exterior: false,
    duracionMin: 90,
    precio: 2.5,
    suplementoLuz: 0,
    unidad: 'sesión',
    pistas: [
      { id: 'gimnasio-sala', nombre: 'Gimnasio del Pabellón' }
    ]
  }
];

/* Clases dirigidas.
   `inscritosBase` y `colaBase` simulan al resto de vecinos ya apuntados:
   sobre ellos se suma la inscripción del usuario (localStorage). */
const CLASES = [
  {
    id: 'pilates',
    nombre: 'Pilates',
    lugar: 'Sala de actividades',
    espacio: 'sala',
    dias: 'Lunes y miércoles',
    hora: '09:30 – 10:20',
    monitor: 'Lucía Barea',
    aforo: 15,
    inscritosBase: 15,
    colaBase: 3,
    precioMes: 16,
    icono: 'i-personas'
  },
  {
    id: 'ciclo',
    nombre: 'Ciclo indoor',
    lugar: 'Sala de ciclo',
    espacio: 'sala',
    dias: 'Martes y jueves',
    hora: '20:00 – 20:50',
    monitor: 'Raúl Benítez',
    aforo: 20,
    inscritosBase: 20,
    colaBase: 1,
    precioMes: 18,
    icono: 'i-flash'
  },
  {
    id: 'zumba',
    nombre: 'Zumba',
    lugar: 'Pabellón cubierto',
    espacio: 'pabellon',
    dias: 'Lunes y miércoles',
    hora: '19:00 – 19:50',
    monitor: 'Marta Collantes',
    aforo: 25,
    inscritosBase: 18,
    colaBase: 0,
    precioMes: 15,
    icono: 'i-personas'
  },
  {
    id: 'gap',
    nombre: 'GAP',
    lugar: 'Sala de actividades',
    espacio: 'sala',
    dias: 'Martes y jueves',
    hora: '09:30 – 10:20',
    monitor: 'Lucía Barea',
    aforo: 15,
    inscritosBase: 9,
    colaBase: 0,
    precioMes: 15,
    icono: 'i-flash'
  },
  {
    id: 'yoga',
    nombre: 'Yoga',
    lugar: 'Sala de actividades',
    espacio: 'sala',
    dias: 'Viernes',
    hora: '18:00 – 19:00',
    monitor: 'Carmen Aragón',
    aforo: 15,
    inscritosBase: 12,
    colaBase: 0,
    precioMes: 12,
    icono: 'i-sol'
  },
  {
    id: 'mantenimiento',
    nombre: 'Gimnasia de mantenimiento',
    lugar: 'Pabellón cubierto',
    espacio: 'pabellon',
    dias: 'Lunes, miércoles y viernes',
    hora: '10:30 – 11:20',
    monitor: 'Paco Reyes',
    aforo: 30,
    inscritosBase: 21,
    colaBase: 0,
    precioMes: 12,
    icono: 'i-personas'
  },
  {
    id: 'aerobic',
    nombre: 'Aerobic-step',
    lugar: 'Sala de actividades',
    espacio: 'sala',
    dias: 'Martes y jueves',
    hora: '18:30 – 19:20',
    monitor: 'Marta Collantes',
    aforo: 15,
    inscritosBase: 13,
    colaBase: 0,
    precioMes: 15,
    icono: 'i-flash'
  },
  {
    id: 'tonofit',
    nombre: 'Tonofit',
    lugar: 'Sala del Pabellón',
    espacio: 'sala',
    dias: 'Lunes y miércoles',
    hora: '20:00 – 20:50',
    monitor: 'Sergio Pantoja',
    aforo: 22,
    inscritosBase: 22,
    colaBase: 5,
    precioMes: 18,
    icono: 'i-flash'
  },
  {
    id: 'voleibol',
    nombre: 'Voleibol',
    lugar: 'Pabellón Polideportivo',
    espacio: 'pabellon',
    dias: 'Sábados',
    hora: '10:00 – 11:15',
    monitor: 'Sergio Pantoja',
    aforo: 18,
    inscritosBase: 11,
    colaBase: 0,
    precioMes: 14,
    icono: 'i-personas'
  },
  {
    id: 'baloncesto',
    nombre: 'Escuela de baloncesto',
    lugar: 'Pabellón cubierto',
    espacio: 'pabellon',
    dias: 'Martes y jueves',
    hora: '17:00 – 18:15',
    monitor: 'Andrés Macías',
    aforo: 20,
    inscritosBase: 14,
    colaBase: 0,
    precioMes: 12,
    icono: 'i-personas'
  }
];

const FILTROS_CLASES = [
  { id: 'todas', nombre: 'Todas' },
  { id: 'sala', nombre: 'Sala' },
  { id: 'pabellon', nombre: 'Pabellón' },
  
  { id: 'con-plazas', nombre: 'Con plazas libres' }
];

/* Horario del complejo: [apertura, cierre) en horas */
const HORARIO = {
  laborable: [9, 23], // lunes a viernes
  finde: [9, 21]      // sábado y domingo
};

const HORA_LUZ = 19;      // desde esta hora, suplemento de luz en pistas exteriores
const DIAS_VISIBLES = 14; // días de antelación para reservar
