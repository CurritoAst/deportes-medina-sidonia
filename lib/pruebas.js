/* ==========================================================================
   Deportes · Medina Sidonia — datos de PRUEBA (fase de pruebas, pre-lanzamiento)
   Dos endpoints solo para el ADMIN, con su botón en el panel (sección Registro):
     POST /api/admin/pruebas/sembrar   crea vecinos de prueba con abonos,
       pulseras ficticias, horas de gimnasio, reservas de pista, inscripciones
       a clases y un recibo devuelto de muestra.
     POST /api/admin/pruebas/limpiar   los borra todos, sin tocar datos reales.
   Todo lo de prueba queda MARCADO para poder retirarlo:
     usuarios  → correo …@prueba.local (borrado con DELETE real: FK en cascada)
     reservas  → localizador MS-PRBnn e id r-90000nn
     gimnasio  → id g-prueba-n · clases → id i-prueba-n · ajustes de aforo base
   Las reservas/gimnasio/clases van al almacén legado (msd_*), que es lo que la
   web usa hasta F4–F6; los usuarios/abonos/recibos van a las tablas reales.
   ========================================================================== */

'use strict';

const crypto = require('crypto');
const bd = require('./bd');
const { responder } = require('./http');
const abonos = require('./abonos');
const recibos = require('./recibos');
const clave = require('./clave');
const { hoy, sumarDias } = require('./fechas');

const DOMINIO = '@prueba.local';
const PERSONAS = [
  ['María García Soto', '1988-03-14'], ['José Ruiz Camacho', '1975-11-02'], ['Lucía Romero Gil', '1996-06-21'],
  ['Antonio Vela Pardo', '1969-01-30'], ['Carmen Ortega Ríos', '1983-09-08'], ['Manuel Sánchez Peña', '1990-12-17'],
  ['Ana Domínguez Luna', '1979-04-25'], ['Francisco Marín Cote', '1958-07-12'], ['Laura Jiménez Vega', '2001-02-05'],
  ['David Moreno Salas', '1993-10-28'], ['Isabel Torres Baro', '1966-05-19'], ['Sergio Núñez Prado', '1998-08-03'],
  ['Rocío Gallardo Mena', '1986-12-09'], ['Javier Benítez Roca', '1972-03-27']
];

/* Herramientas sobre el almacén legado (estado clave-valor en memoria del server) */
function almacenLegado({ obtenerEstado, persistir, difundir }) {
  const estado = obtenerEstado();
  return {
    leer(k) { try { const v = JSON.parse(estado[k] || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } },
    leerObj(k) { try { const v = JSON.parse(estado[k] || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (e) { return {}; } },
    guardar(k, v) { const cuerpo = JSON.stringify(v); estado[k] = cuerpo; persistir(); difundir(k, cuerpo, null); }
  };
}

async function anotar(texto, actorId, ip) {
  await bd.consulta("INSERT INTO registro_actividad (tipo, texto, actor_usuario_id, ip) VALUES ('sistema', ?, ?, ?)",
    [String(texto).slice(0, 400), actorId || null, ip || null]).catch(() => {});
}

async function sembrar(ctx, actorId, ip) {
  const resumen = { usuarios: 0, abonos: 0, gimnasio: 0, reservas: 0, clases: 0, impagos: 0 };
  const ids = [];

  // 1) Vecinos de prueba (verificados, sin contraseña utilizable)
  for (let i = 0; i < PERSONAS.length; i++) {
    const [nombre, nac] = PERSONAS[i];
    const email = `prueba${i + 1}${DOMINIO}`;
    let u = await bd.uno('SELECT id FROM usuarios WHERE email = ?', [email]);
    if (!u) {
      const hash = await clave.hashear(crypto.randomBytes(24).toString('base64url'));
      const r = await bd.consulta(
        "INSERT INTO usuarios (email, nombre, telefono, fecha_nacimiento, rol, clave_hash, email_verificado_en, acepta_normas_en) VALUES (?, ?, ?, ?, 'vecino', ?, NOW(3), NOW(3))",
        [email, nombre, '6' + String(23456701 + i * 13579).slice(0, 8), nac, hash]);
      u = { id: r.insertId };
      resumen.usuarios++;
    }
    ids.push({ id: String(u.id), nombre, i });
  }

  // 2) Abonos: los 10 primeros en vigor (la mitad con domiciliación); 2 con pulsera ficticia 99…
  for (const p of ids.slice(0, 10)) {
    const a = await bd.uno('SELECT id FROM abonos WHERE usuario_id = ?', [p.id]);
    if (!a) {
      const r = await abonos.altaAbono({ usuarioId: Number(p.id), meses: 1 + (p.i % 3), autoRenovar: p.i % 2 === 0, nfcUid: p.i < 2 ? String(9900000010 + p.i) : undefined, actorId });
      if (!r || !r.error) resumen.abonos++;
    }
  }

  // 3) Un impago de muestra: recibo domiciliado devuelto de la tercera persona
  const moroso = ids[2];
  const hayDevuelto = await bd.uno("SELECT id FROM recibos WHERE usuario_id = ? AND estado = 'devuelto'", [moroso.id]);
  if (!hayDevuelto) {
    const rid = await recibos.crear(null, { usuarioId: Number(moroso.id), periodo: hoy(), concepto: 'Mensualidad del abono (domiciliación)', importe: 18, metodo: 'domiciliacion', estado: 'pendiente' });
    await recibos.marcar({ reciboId: rid, estado: 'devuelto', actorId });
    resumen.impagos = 1;
  }

  // 4) Almacén legado: gimnasio, reservas de pista y clases (lo que ve la web hasta F4–F6)
  const alm = almacenLegado(ctx);

  const gim = alm.leer('msd_gimnasio').filter((g) => !String(g && g.id).startsWith('g-prueba-'));
  const franjas = ['10:00', '18:00', '19:00'];
  ids.slice(0, 6).forEach((p, n) => gim.push({
    id: 'g-prueba-' + (n + 1), usuarioId: p.id, franja: franjas[n % 3], desde: Date.now() - (n + 1) * 60000,
    nota: n === 0 ? 'Rodilla delicada: sin impacto' : ''
  }));
  alm.guardar('msd_gimnasio', gim);
  resumen.gimnasio = 6;

  // Reservas para mañana y pasado en horas de tarde (id r-\d+ y localizador MS-… como exige la web)
  const reservas = alm.leer('msd_reservas').filter((r) => !String(r && r.localizador || '').startsWith('MS-PRB'));
  const PLAN = [
    ['padel', 'padel-1', 1, 18 * 60, 4], ['padel', 'padel-1', 1, 19 * 60 + 30, 6], ['padel', 'padel-2', 1, 18 * 60, 4],
    ['tenis', 'tenis-1', 1, 19 * 60, 5], ['futbol7', 'futbol7-1', 1, 20 * 60, 31], ['pabellon', 'pabellon-central', 1, 19 * 60, 16],
    ['padel', 'padel-1', 2, 10 * 60 + 30, 4], ['padel', 'padel-2', 2, 18 * 60, 4], ['tenis', 'tenis-1', 2, 10 * 60, 3],
    ['futbol7', 'futbol7-2', 2, 19 * 60, 25], ['sala', 'sala-1', 2, 17 * 60, 8], ['pabellon', 'pabellon-central', 2, 20 * 60, 16]
  ];
  PLAN.forEach((x, n) => {
    const p = ids[n % ids.length];
    reservas.push({
      id: 'r-9000' + String(n + 1).padStart(2, '0'),
      localizador: 'MS-PRB' + String(n + 1).padStart(2, '0'),
      instId: x[0], pistaId: x[1], usuarioId: p.id, nombre: p.nombre,
      fecha: sumarDias(hoy(), x[2]), hora: x[3], precio: x[4], creada: Date.now()
    });
  });
  alm.guardar('msd_reservas', reservas);
  resumen.reservas = PLAN.length;

  // Clases: inscripciones con nombre (para el panel) + aforo base para que la web
  // pública también muestre los huecos ocupados (ciclo queda LLENO con cola)
  const insc = alm.leer('msd_inscripciones').filter((i) => !String(i && i.id || '').startsWith('i-prueba-'));
  const CLASES_PLAN = [['pilates', 0], ['pilates', 1], ['zumba', 2], ['zumba', 3], ['ciclo', 4], ['yoga', 5], ['gap', 6], ['tonofit', 7]];
  CLASES_PLAN.forEach(([claseId, n], k) => insc.push({ id: 'i-prueba-' + (k + 1), claseId, usuarioId: ids[n].id, estado: 'inscrito', desde: Date.now() - (k + 1) * 60000 }));
  alm.guardar('msd_inscripciones', insc);
  const ajustes = alm.leerObj('msd_clases_ajustes');
  Object.assign(ajustes, {
    pilates: { inscritosBase: 11, colaBase: 0 },
    zumba: { inscritosBase: 17, colaBase: 0 },
    ciclo: { inscritosBase: 19, colaBase: 2 },     // 19 base + 1 inscripción = 20/20 LLENA con 2 en cola
    yoga: { inscritosBase: 9, colaBase: 0 },
    mantenimiento: { inscritosBase: 22, colaBase: 0 }
  });
  alm.guardar('msd_clases_ajustes', ajustes);
  resumen.clases = CLASES_PLAN.length;

  await anotar(`Datos de PRUEBA sembrados: ${resumen.usuarios} vecinos nuevos, ${resumen.abonos} abonos, ${resumen.reservas} reservas, ${resumen.gimnasio} en gimnasio, ${resumen.clases} inscripciones a clases, ${resumen.impagos} impago de muestra.`, actorId, ip);
  return resumen;
}

async function limpiar(ctx, actorId, ip) {
  const filas = await bd.consulta('SELECT id FROM usuarios WHERE email LIKE ?', ['%' + DOMINIO]);
  const idSet = new Set(filas.map((f) => String(f.id)));
  for (const f of filas) await bd.consulta('DELETE FROM usuarios WHERE id = ?', [f.id]);   // FK en cascada: abonos, carnets, recibos, sesiones…

  const alm = almacenLegado(ctx);
  alm.guardar('msd_gimnasio', alm.leer('msd_gimnasio').filter((g) => g && !String(g.id).startsWith('g-prueba-') && !idSet.has(String(g.usuarioId))));
  alm.guardar('msd_reservas', alm.leer('msd_reservas').filter((r) => r && !String(r.localizador || '').startsWith('MS-PRB') && !idSet.has(String(r.usuarioId))));
  alm.guardar('msd_inscripciones', alm.leer('msd_inscripciones').filter((i) => i && !String(i.id || '').startsWith('i-prueba-') && !idSet.has(String(i.usuarioId))));
  const ajustes = alm.leerObj('msd_clases_ajustes');
  for (const k of ['pilates', 'zumba', 'ciclo', 'yoga', 'mantenimiento']) ajustes[k] = { inscritosBase: 0, colaBase: 0 };
  alm.guardar('msd_clases_ajustes', ajustes);

  await anotar(`Datos de PRUEBA borrados: ${filas.length} vecinos @prueba.local con sus abonos, recibos, reservas, gimnasio y clases.`, actorId, ip);
  return { usuariosBorrados: filas.length };
}

function montar(router, ctx) {
  const A = ['admin'];
  router.ruta('POST', '/api/admin/pruebas/sembrar', A, { handler: async (c) => responder(c.res, 200, await sembrar(ctx, c.usuario.id, c.ip)) });
  router.ruta('POST', '/api/admin/pruebas/limpiar', A, { handler: async (c) => responder(c.res, 200, await limpiar(ctx, c.usuario.id, c.ip)) });
}

module.exports = { montar, sembrar, limpiar };
