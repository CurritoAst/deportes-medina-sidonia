-- ============================================================
-- 002_semillas.sql — catálogo y ajustes (NO datos personales)
-- Las instalaciones/pistas y las clases son el punto de partida; después las
-- edita el admin desde el panel. Los precios NO se vuelven a pisar nunca
-- (el UPSERT de arranque solo actualiza nombre/duración/orden, ver server.js).
-- ============================================================

INSERT INTO instalaciones (id, nombre, exterior, duracion_min, precio, suplemento_luz, unidad, reservable_online, orden) VALUES
  ('padel',    'Pádel',                  1, 90, 4.00,  2.00, '90 min', 1, 1),
  ('tenis',    'Tenis',                  1, 60, 3.00,  2.00, 'hora',   1, 2),
  ('futbol7',  'Fútbol 7',               1, 60, 25.00, 6.00, 'hora',   1, 3),
  ('pabellon', 'Pabellón Polideportivo', 0, 60, 16.00, 0.00, 'hora',   1, 4),
  ('sala',     'Salas del Pabellón',     0, 60, 8.00,  0.00, 'hora',   1, 5),
  ('gimnasio', 'Gimnasio del Pabellón',  0, 90, 2.50,  0.00, 'sesión', 0, 6);

INSERT INTO pistas (id, instalacion_id, nombre, orden) VALUES
  ('padel-1',          'padel',    'Pádel Pista 1',                1),
  ('padel-2',          'padel',    'Pádel Pista 2',                2),
  ('tenis-1',          'tenis',    'Pista de Tenis',               1),
  ('futbol7-1',        'futbol7',  'Fútbol 7 · Pista 1 (Cantina)', 1),
  ('futbol7-2',        'futbol7',  'Fútbol 7 · Pista 2',           2),
  ('pabellon-central', 'pabellon', 'Pista del Pabellón',           1),
  ('sala-1',           'sala',     'Sala del Pabellón',            1),
  ('gimnasio-sala',    'gimnasio', 'Gimnasio del Pabellón',        1);

INSERT INTO clases (id, nombre, lugar, espacio, dias_texto, hora_texto, monitor_nombre, aforo, precio_mes, icono, orden) VALUES
  ('pilates',       'Pilates',                   'Sala de actividades',    'sala',     'Lunes y miércoles',          '09:30 – 10:20', 'Lucía Barea',     15, 16.00, 'i-personas', 1),
  ('ciclo',         'Ciclo indoor',              'Sala de ciclo',          'sala',     'Martes y jueves',            '20:00 – 20:50', 'Raúl Benítez',    20, 18.00, 'i-flash',    2),
  ('zumba',         'Zumba',                     'Pabellón cubierto',      'pabellon', 'Lunes y miércoles',          '19:00 – 19:50', 'Marta Collantes', 25, 15.00, 'i-personas', 3),
  ('gap',           'GAP',                       'Sala de actividades',    'sala',     'Martes y jueves',            '09:30 – 10:20', 'Lucía Barea',     15, 15.00, 'i-flash',    4),
  ('yoga',          'Yoga',                      'Sala de actividades',    'sala',     'Viernes',                    '18:00 – 19:00', 'Carmen Aragón',   15, 12.00, 'i-sol',      5),
  ('mantenimiento', 'Gimnasia de mantenimiento', 'Pabellón cubierto',      'pabellon', 'Lunes, miércoles y viernes', '10:30 – 11:20', 'Paco Reyes',      30, 12.00, 'i-personas', 6),
  ('aerobic',       'Aerobic-step',              'Sala de actividades',    'sala',     'Martes y jueves',            '18:30 – 19:20', 'Marta Collantes', 15, 15.00, 'i-flash',    7),
  ('tonofit',       'Tonofit',                   'Sala del Pabellón',      'sala',     'Lunes y miércoles',          '20:00 – 20:50', 'Sergio Pantoja',  22, 18.00, 'i-flash',    8),
  ('voleibol',      'Voleibol',                  'Pabellón Polideportivo', 'pabellon', 'Sábados',                    '10:00 – 11:15', 'Sergio Pantoja',  18, 14.00, 'i-personas', 9),
  ('baloncesto',    'Escuela de baloncesto',     'Pabellón cubierto',      'pabellon', 'Martes y jueves',            '17:00 – 18:15', 'Andrés Macías',   20, 12.00, 'i-personas', 10);

-- Gimnasio por horas: 09:00..21:00, franjas de 1 h, capacidad 20
INSERT INTO gimnasio_franjas (hora_inicio, duracion_min, capacidad) VALUES
  ('09:00:00',60,20),('10:00:00',60,20),('11:00:00',60,20),('12:00:00',60,20),('13:00:00',60,20),
  ('14:00:00',60,20),('15:00:00',60,20),('16:00:00',60,20),('17:00:00',60,20),('18:00:00',60,20),
  ('19:00:00',60,20),('20:00:00',60,20),('21:00:00',60,20);

INSERT INTO ajustes (clave, valor) VALUES
  ('reserva_desde_dias',    '0'),
  ('reserva_dias_ventana',  '14'),
  ('abono_precio_mes',      '18'),
  ('aforo_max',             '40'),
  ('edad_minima',           '16'),
  ('hora_luz',              '19'),
  ('horario_laborable',     '[9, 23]'),
  ('horario_finde',         '[9, 21]'),
  ('max_reservas_futuras',  '2'),
  ('cancelacion_min_horas', '24');
