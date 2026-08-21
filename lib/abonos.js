/* ==========================================================================
   Deportes · Medina Sidonia — abonos y carnets (lógica de servidor)
   · El ABONO es el estado actual de la persona (1 fila): activo, desde, hasta,
     auto_renovar. Vigente <=> activo=1 AND hasta >= hoy (Madrid).
   · El CARNET son sus credenciales de acceso (1 fila, sobrevive a bajas):
       nfc_uid   UID real de la pulsera (lo asigna el admin; nunca se muestra al socio)
       qr_uid    identificador PROPIO del QR (10 dígitos aleatorios) = prefijo del QR
       qr_seed   semilla secreta (32 hex) del QR dinámico; solo sale hacia el torno
   · Todo lo que cambia el abono queda en abono_movimientos (finanzas) y en
     registro_actividad (auditoría).
   ========================================================================== */

'use strict';

const crypto = require('crypto');
const bd = require('./bd');
const { hoy, sumarMeses, esClaveDia } = require('./fechas');
const token = require('./token');

const ahora = () => new Date();

/* ---------- Lecturas ---------- */

async function ajuste(clave, porDefecto) {
  const f = await bd.uno('SELECT valor FROM ajustes WHERE clave = ?', [clave]);
  if (!f) return porDefecto;
  try { return typeof f.valor === 'string' ? JSON.parse(f.valor) : f.valor; } catch (e) { return porDefecto; }
}

async function abonoDe(usuarioId) {
  return bd.uno('SELECT * FROM abonos WHERE usuario_id = ?', [usuarioId]);
}
async function carnetDe(usuarioId) {
  return bd.uno('SELECT * FROM carnets WHERE usuario_id = ?', [usuarioId]);
}

const esVigente = (a, dia) => !!(a && a.activo && String(a.hasta) >= (dia || hoy()));

/* Vista del abono hacia el PROPIO socio (sin UID completo, sin seed). */
function vistaAbonoPropio(a, c) {
  if (!a) return null;
  const uid = c && c.nfc_uid ? String(c.nfc_uid) : '';
  return {
    activo: !!a.activo,
    desde: String(a.desde),
    hasta: String(a.hasta),
    autoRenovar: !!a.auto_renovar,
    vigente: esVigente(a),
    nfcUltimos4: uid ? uid.slice(-4) : null,
    tienePulsera: !!uid,
    qrUid: c && !c.revocado_en ? c.qr_uid : null
  };
}
/* Vista del abono hacia el ADMIN (con UID completo, sin seed). */
function vistaAbonoAdmin(a, c) {
  if (!a && !c) return null;
  return {
    activo: a ? !!a.activo : false,
    desde: a ? String(a.desde) : null,
    hasta: a ? String(a.hasta) : null,
    autoRenovar: a ? !!a.auto_renovar : false,
    vigente: esVigente(a),
    nfcUid: c && c.nfc_uid ? String(c.nfc_uid) : null,
    nfcId: c && c.nfc_id_legacy ? c.nfc_id_legacy : null,
    qrUid: c ? c.qr_uid : null,
    carnetRevocado: !!(c && c.revocado_en),
    seedRotadaEn: c && c.seed_rotada_en ? new Date(c.seed_rotada_en).toISOString() : null
  };
}

/* ---------- Carnet ---------- */

function nuevoQrUid() {
  // 10 dígitos, sin cero inicial para que ningún cliente lo "recorte" como número
  return String(crypto.randomInt(1000000000, 9999999999));
}
const nuevaSeed = () => crypto.randomBytes(16).toString('hex');

/* Garantiza que el usuario tiene carnet (qr_uid + qr_seed). Devuelve la fila. */
async function asegurarCarnet(con, usuarioId) {
  const q = (sql, p) => (con ? con.query(sql, p).then((r) => r[0]) : bd.consulta(sql, p));
  let c = (await q('SELECT * FROM carnets WHERE usuario_id = ?', [usuarioId]))[0];
  if (c) {
    if (c.revocado_en) { await q('UPDATE carnets SET revocado_en = NULL WHERE id = ?', [c.id]); c.revocado_en = null; }
    return c;
  }
  for (let intento = 0; intento < 5; intento++) {
    try {
      const r = await q('INSERT INTO carnets (usuario_id, qr_uid, qr_seed) VALUES (?, ?, ?)', [usuarioId, nuevoQrUid(), nuevaSeed()]);
      return (await q('SELECT * FROM carnets WHERE id = ?', [r.insertId]))[0];
    } catch (e) {
      if (!bd.esDuplicado(e) || intento === 4) throw e;   // choque de qr_uid: reintenta
    }
  }
  return null;
}

/* ---------- Operaciones del admin ---------- */

async function movimiento(con, abonoId, tipo, desde, hasta, importe, actorId) {
  await con.query('INSERT INTO abono_movimientos (abono_id, tipo, desde, hasta, importe, realizado_por) VALUES (?, ?, ?, ?, ?, ?)',
    [abonoId, tipo, desde || null, hasta || null, importe || 0, actorId || null]);
}
async function anotar(con, tipo, texto, actorId, entidadId, ip) {
  await con.query('INSERT INTO registro_actividad (tipo, texto, actor_usuario_id, entidad, entidad_id, ip) VALUES (?, ?, ?, ?, ?, ?)',
    [tipo, String(texto).slice(0, 400), actorId || null, 'usuario', String(entidadId), ip || null]);
}
async function notificar(con, usuarioId, tipo, texto) {
  await con.query('INSERT INTO notificaciones (usuario_id, tipo, texto) VALUES (?, ?, ?)', [usuarioId, tipo, String(texto).slice(0, 300)]);
}

/* Alta (o reactivación) de abono: hasta = sumarMeses(max(hasta actual, hoy), meses). */
async function altaAbono({ usuarioId, meses, autoRenovar, nfcUid, actorId, ip }) {
  meses = Math.max(1, Math.min(12, Number(meses) || 1));
  const precio = Number(await ajuste('abono_precio_mes', 18)) || 0;
  return bd.enTransaccion(async (con) => {
    const [[u]] = await con.query('SELECT id, nombre FROM usuarios WHERE id = ? AND eliminado_en IS NULL FOR UPDATE', [usuarioId]);
    if (!u) return { error: 'Usuario no encontrado', codigo: 'NO_EXISTE' };
    const d = hoy();
    let [[a]] = await con.query('SELECT * FROM abonos WHERE usuario_id = ? FOR UPDATE', [usuarioId]);
    let tipo;
    if (!a) {
      const hasta = sumarMeses(d, meses);
      const r = await con.query('INSERT INTO abonos (usuario_id, activo, desde, hasta, auto_renovar) VALUES (?, 1, ?, ?, ?)', [usuarioId, d, hasta, autoRenovar ? 1 : 0]);
      a = { id: r[0].insertId, desde: d, hasta };
      tipo = 'alta';
    } else {
      const base = (a.activo && String(a.hasta) >= d) ? String(a.hasta) : d;
      const hasta = sumarMeses(base, meses);
      await con.query('UPDATE abonos SET activo = 1, desde = IF(activo = 1 AND hasta >= ?, desde, ?), hasta = ?, auto_renovar = ?, baja_en = NULL WHERE id = ?', [d, d, hasta, autoRenovar ? 1 : 0, a.id]);
      tipo = a.activo && String(a.hasta) >= d ? 'renovacion' : 'reactivacion';
      a = { id: a.id, desde: a.desde, hasta };
    }
    const c = await asegurarCarnet(con, usuarioId);
    if (nfcUid) {
      const r = await asignarUid(con, usuarioId, nfcUid);
      if (r.error) throw Object.assign(new Error(r.error), { codigo: r.codigo, de: r.de });
    }
    await movimiento(con, a.id, tipo, a.desde, a.hasta, precio * meses, actorId);
    await anotar(con, 'abono', `${tipo === 'alta' ? 'Alta' : tipo === 'renovacion' ? 'Renovación' : 'Reactivación'} de abono de ${u.nombre} hasta el ${a.hasta} (${meses} mes/es, ${precio * meses} €).`, actorId, usuarioId, ip);
    await notificar(con, usuarioId, 'abono', `Tu abono del gimnasio está en vigor hasta el ${a.hasta}.`);
    return { ok: true, abono: await bd.uno('SELECT * FROM abonos WHERE id = ?', [a.id]), carnet: c };
  }).catch((e) => (e.codigo ? { error: e.message, codigo: e.codigo, de: e.de } : Promise.reject(e)));
}

async function bajaAbono({ usuarioId, actorId, ip }) {
  return bd.enTransaccion(async (con) => {
    const [[a]] = await con.query('SELECT a.*, u.nombre FROM abonos a JOIN usuarios u ON u.id = a.usuario_id WHERE a.usuario_id = ? FOR UPDATE', [usuarioId]);
    if (!a) return { error: 'Este usuario no tiene abono', codigo: 'SIN_ABONO' };
    await con.query('UPDATE abonos SET activo = 0, auto_renovar = 0, baja_en = ? WHERE id = ?', [ahora(), a.id]);
    await movimiento(con, a.id, 'baja', a.desde, a.hasta, 0, actorId);
    await anotar(con, 'abono', `Baja del abono de ${a.nombre}. El torno dejará de aceptar su carnet.`, actorId, usuarioId, ip);
    await notificar(con, usuarioId, 'abono', 'Tu abono del gimnasio se ha dado de baja. Puedes reactivarlo en recepción.');
    return { ok: true };
  });
}

async function autoRenovar({ usuarioId, valor, actorId }) {
  const r = await bd.consulta('UPDATE abonos SET auto_renovar = ? WHERE usuario_id = ? AND activo = 1', [valor ? 1 : 0, usuarioId]);
  return r.affectedRows ? { ok: true } : { error: 'Sin abono activo', codigo: 'SIN_ABONO' };
}

/* Asigna el UID real de la pulsera (UNIQUE → 409 con el nombre de quien lo tiene). */
async function asignarUid(con, usuarioId, nfcUid) {
  const uid = String(nfcUid || '').trim();
  if (!/^\d{6,20}$/.test(uid)) return { error: 'El UID debe ser un número de 6 a 20 dígitos.', codigo: 'UID_INVALIDO' };
  const q = (sql, p) => con.query(sql, p).then((r) => r[0]);
  const [otro] = await q('SELECT c.usuario_id, u.nombre FROM carnets c JOIN usuarios u ON u.id = c.usuario_id WHERE c.nfc_uid = ? AND c.usuario_id <> ?', [uid, usuarioId]);
  if (otro) return { error: `Ese UID ya está asignado a ${otro.nombre}.`, codigo: 'UID_EN_USO', de: otro.nombre };
  await asegurarCarnet(con, usuarioId);
  await q('UPDATE carnets SET nfc_uid = ? WHERE usuario_id = ?', [uid, usuarioId]);
  return { ok: true, nfcUid: uid };
}

async function asignarPulsera({ usuarioId, nfcUid, birthdate, actorId, ip }) {
  if (birthdate !== undefined && birthdate !== '' && !esClaveDia(birthdate)) return { error: 'Fecha de nacimiento no válida.', codigo: 'FECHA_INVALIDA' };
  return bd.enTransaccion(async (con) => {
    const [[u]] = await con.query('SELECT id, nombre FROM usuarios WHERE id = ? AND eliminado_en IS NULL', [usuarioId]);
    if (!u) return { error: 'Usuario no encontrado', codigo: 'NO_EXISTE' };
    const r = await asignarUid(con, usuarioId, nfcUid);
    if (r.error) return r;
    if (birthdate !== undefined) await con.query('UPDATE usuarios SET fecha_nacimiento = ? WHERE id = ?', [birthdate || null, usuarioId]);
    await anotar(con, 'acceso', `Pulsera asignada a ${u.nombre}: UID …${r.nfcUid.slice(-4)}${birthdate ? ', nacimiento ' + birthdate : ''}.`, actorId, usuarioId, ip);
    return { ok: true, nfcUid: r.nfcUid };
  });
}

async function liberarPulsera({ usuarioId, actorId, ip }) {
  return bd.enTransaccion(async (con) => {
    const [[u]] = await con.query('SELECT u.nombre, c.nfc_uid FROM usuarios u LEFT JOIN carnets c ON c.usuario_id = u.id WHERE u.id = ?', [usuarioId]);
    if (!u) return { error: 'Usuario no encontrado', codigo: 'NO_EXISTE' };
    await con.query('UPDATE carnets SET nfc_uid = NULL WHERE usuario_id = ?', [usuarioId]);
    await anotar(con, 'acceso', `Pulsera liberada de ${u.nombre}${u.nfc_uid ? ' (UID …' + String(u.nfc_uid).slice(-4) + ')' : ''}.`, actorId, usuarioId, ip);
    return { ok: true };
  });
}

/* Nueva semilla (móvil perdido / sospecha de copia): los QR anteriores dejan de valer. */
async function rotarSeed({ usuarioId, actorId, ip }) {
  return bd.enTransaccion(async (con) => {
    const c = await asegurarCarnet(con, usuarioId);
    await con.query('UPDATE carnets SET qr_seed = ?, seed_rotada_en = ? WHERE id = ?', [nuevaSeed(), ahora(), c.id]);
    await anotar(con, 'acceso', `Semilla del QR rotada para el usuario ${usuarioId}: los QR anteriores ya no valen.`, actorId, usuarioId, ip);
    await notificar(con, usuarioId, 'abono', 'Hemos renovado tu carnet digital: abre el perfil para que el QR se actualice.');
    return { ok: true };
  });
}

/* ---------- QR del socio (lote de códigos, SIN semilla) ---------- */
const LOTE_VENTANAS = 20;

async function loteQr(usuarioId) {
  const a = await abonoDe(usuarioId);
  if (!esVigente(a)) return { error: 'Necesitas un abono en vigor para usar el QR.', codigo: 'SIN_ABONO' };
  const c = await carnetDe(usuarioId);
  if (!c || c.revocado_en) return { error: 'Tu carnet no está activo. Pásate por recepción.', codigo: 'SIN_CARNET' };
  const lote = token.generarLote(c.qr_uid, c.qr_seed, LOTE_VENTANAS);
  return { ok: true, qrUid: c.qr_uid, desdeT: lote.desdeT, ventana: token.VENTANA, codigos: lote.codigos, servidorMs: Date.now(), nfcUltimos4: c.nfc_uid ? String(c.nfc_uid).slice(-4) : null };
}

/* ---------- Socios para el torno (único sitio que entrega qr_seed) ---------- */
async function sociosParaTorno() {
  const filas = await bd.consulta(
    `SELECT u.id, u.nombre, u.fecha_nacimiento, a.activo, a.hasta, c.nfc_uid, c.nfc_id_legacy, c.qr_uid, c.qr_seed,
            (SELECT f.hora_inicio FROM gimnasio_inscripciones gi JOIN gimnasio_franjas f ON f.id = gi.franja_id
              WHERE gi.usuario_id = u.id AND gi.baja_en IS NULL ORDER BY gi.desde LIMIT 1) AS gym_hora,
            (SELECT f.duracion_min FROM gimnasio_inscripciones gi JOIN gimnasio_franjas f ON f.id = gi.franja_id
              WHERE gi.usuario_id = u.id AND gi.baja_en IS NULL ORDER BY gi.desde LIMIT 1) AS gym_dur
       FROM usuarios u
       JOIN carnets c ON c.usuario_id = u.id AND c.revocado_en IS NULL
       LEFT JOIN abonos a ON a.usuario_id = u.id
      WHERE u.eliminado_en IS NULL`);
  return filas.map((f) => {
    let gym = null;
    if (f.gym_hora) {
      const hi = String(f.gym_hora).slice(0, 5);
      const [h, m] = hi.split(':').map(Number);
      const finMin = h * 60 + m + (Number(f.gym_dur) || 60);
      gym = { franja: hi, fin: `${String(Math.floor(finMin / 60) % 24).padStart(2, '0')}:${String(finMin % 60).padStart(2, '0')}` };
    }
    return {
      id: String(f.id), nombre: f.nombre,
      nfcUid: f.nfc_uid ? String(f.nfc_uid) : null,
      nfcId: f.nfc_id_legacy || null,
      qrUid: String(f.qr_uid),
      qrSeed: f.qr_seed,
      activo: !!f.activo,
      hasta: f.hasta ? String(f.hasta) : '1970-01-01',
      birthdate: f.fecha_nacimiento ? String(f.fecha_nacimiento) : '',
      gym
    };
  });
}

/* ETag barato: cambia si cambia algo relevante para el torno. */
async function etagTorno() {
  const f = await bd.uno(
    `SELECT (SELECT COUNT(*) FROM carnets) c1, (SELECT COALESCE(MAX(UNIX_TIMESTAMP(emitido_en)),0) FROM carnets) c2,
            (SELECT COALESCE(MAX(UNIX_TIMESTAMP(seed_rotada_en)),0) FROM carnets) c3,
            (SELECT COALESCE(SUM(CASE WHEN nfc_uid IS NULL THEN 0 ELSE 1 END),0) FROM carnets) c4,
            (SELECT COALESCE(MAX(UNIX_TIMESTAMP(actualizado_en)),0) FROM abonos) a1, (SELECT COUNT(*) FROM abonos) a2,
            (SELECT COALESCE(MAX(UNIX_TIMESTAMP(actualizado_en)),0) FROM usuarios) u1,
            (SELECT COUNT(*) FROM gimnasio_inscripciones WHERE baja_en IS NULL) g1, (SELECT COALESCE(MAX(UNIX_TIMESTAMP(desde)),0) FROM gimnasio_inscripciones) g2`);
  const base = Object.values(f || {}).join('|');
  return '"' + crypto.createHash('sha256').update(base).digest('hex').slice(0, 32) + '"';
}

module.exports = { abonoDe, carnetDe, esVigente, vistaAbonoPropio, vistaAbonoAdmin, asegurarCarnet, altaAbono, bajaAbono, autoRenovar, asignarPulsera, liberarPulsera, rotarSeed, loteQr, sociosParaTorno, etagTorno, ajuste, LOTE_VENTANAS };
