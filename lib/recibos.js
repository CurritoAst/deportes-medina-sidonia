/* ==========================================================================
   Deportes · Medina Sidonia — recibos de la mensualidad (domiciliación)
   · El PRIMER pago es con tarjeta en recepción: altaAbono (lib/abonos.js)
     crea ese recibo ya PAGADO al dar el alta.
   · Las mensualidades siguientes las cobra el banco por fuera (domiciliación):
     renovarVencidos() alarga 1 mes los abonos con auto_renovar=1 al caducar y
     emite el recibo 'pendiente'. Recepción lo marca 'pagado' o 'devuelto'
     cuando recaudación le pasa el resultado.
   · Un recibo DEVUELTO abre un plazo (ajustes.impago_margen_dias): dentro del
     plazo el torno AVISA; vencido, DENIEGA. Y no se renueva más hasta pagar.
   ========================================================================== */

'use strict';

const bd = require('./bd');
const { hoy, sumarDias, sumarMeses } = require('./fechas');

const ahora = () => new Date();
const MARGEN_POR_DEFECTO = 7;      // días de plazo tras el impago antes de cortar el torno

async function ajuste(clave, porDefecto) {
  const f = await bd.uno('SELECT valor FROM ajustes WHERE clave = ?', [clave]);
  if (!f) return porDefecto;
  try { return typeof f.valor === 'string' ? JSON.parse(f.valor) : f.valor; } catch (e) { return porDefecto; }
}

async function margenDias() {
  const n = Number(await ajuste('impago_margen_dias', MARGEN_POR_DEFECTO));
  return Number.isFinite(n) && n >= 0 ? Math.min(90, Math.round(n)) : MARGEN_POR_DEFECTO;
}

/* Momento (ms) en que vence el plazo de un impago marcado en `devueltoEn`. */
const venceDe = (devueltoEn, margen) => new Date(devueltoEn).getTime() + margen * 86400e3;

/* Crea un recibo. `con` es la conexión de una transacción en curso (o null → pool). */
async function crear(con, r) {
  const q = (sql, p) => (con ? con.query(sql, p).then((x) => x[0]) : bd.consulta(sql, p));
  const res = await q(
    'INSERT INTO recibos (usuario_id, abono_id, periodo, concepto, importe, metodo, estado, pagado_en, actualizado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [r.usuarioId, r.abonoId || null, String(r.periodo).slice(0, 7), String(r.concepto).slice(0, 120), r.importe || 0,
      r.metodo || 'domiciliacion', r.estado || 'pendiente', r.estado === 'pagado' ? ahora() : null, r.actorId || null]);
  return res.insertId;
}

const ms = (v) => (v ? new Date(v).getTime() : null);

function vistaRecibo(f, margen) {
  return {
    id: String(f.id),
    periodo: f.periodo,
    concepto: f.concepto,
    importe: Number(f.importe) || 0,
    metodo: f.metodo,
    estado: f.estado,
    creadoEn: ms(f.creado_en),
    pagadoEn: ms(f.pagado_en),
    devueltoEn: ms(f.devuelto_en),
    venceEn: f.estado === 'devuelto' && f.devuelto_en ? venceDe(f.devuelto_en, margen) : null
  };
}

/* Últimos recibos de una persona (para la ficha del admin y el perfil del socio). */
async function recibosDe(usuarioId, limite) {
  const margen = await margenDias();
  const filas = await bd.consulta('SELECT * FROM recibos WHERE usuario_id = ? ORDER BY creado_en DESC LIMIT ?', [usuarioId, Math.max(1, Math.min(24, limite || 6))]);
  return filas.map((f) => vistaRecibo(f, margen));
}

/* Marca un recibo (pagado / devuelto / pendiente / anulado) y lo deja anotado. */
async function marcar({ reciboId, estado, actorId, ip }) {
  if (!['pendiente', 'pagado', 'devuelto', 'anulado'].includes(estado)) return { error: 'Estado de recibo no válido.', codigo: 'ESTADO' };
  return bd.enTransaccion(async (con) => {
    const [[r]] = await con.query('SELECT r.*, u.nombre FROM recibos r JOIN usuarios u ON u.id = r.usuario_id WHERE r.id = ? FOR UPDATE', [reciboId]);
    if (!r) return { error: 'Recibo no encontrado.', codigo: 'NO_EXISTE' };
    if (r.estado === estado) return { ok: true, usuarioId: String(r.usuario_id), sinCambio: true };
    await con.query('UPDATE recibos SET estado = ?, pagado_en = ?, devuelto_en = ?, actualizado_por = ? WHERE id = ?',
      [estado, estado === 'pagado' ? ahora() : null, estado === 'devuelto' ? ahora() : null, actorId || null, reciboId]);
    await con.query("INSERT INTO registro_actividad (tipo, texto, actor_usuario_id, entidad, entidad_id, ip) VALUES ('finanzas', ?, ?, 'recibo', ?, ?)",
      [`Recibo de ${r.nombre} (${r.periodo}, ${Number(r.importe)} €) marcado como ${estado}.`, actorId || null, String(reciboId), ip || null]);
    if (estado === 'devuelto') {
      await con.query('INSERT INTO notificaciones (usuario_id, tipo, texto) VALUES (?, ?, ?)',
        [r.usuario_id, 'abono', `El banco ha devuelto tu recibo de ${r.periodo}. Pásate por recepción para regularizarlo.`]);
    }
    if (estado === 'pagado' && r.estado === 'devuelto') {
      await con.query('INSERT INTO notificaciones (usuario_id, tipo, texto) VALUES (?, ?, ?)',
        [r.usuario_id, 'abono', `Tu recibo de ${r.periodo} ya consta como pagado. Gracias.`]);
    }
    return { ok: true, usuarioId: String(r.usuario_id) };
  });
}

/* Impagos abiertos, para la tarjeta roja del Inicio del panel. */
async function impagos() {
  const margen = await margenDias();
  const filas = await bd.consulta(
    `SELECT r.*, u.nombre, u.email, u.telefono FROM recibos r JOIN usuarios u ON u.id = r.usuario_id
      WHERE r.estado = 'devuelto' AND u.eliminado_en IS NULL ORDER BY r.devuelto_en`);
  const t = Date.now();
  return {
    margenDias: margen,
    impagos: filas.map((f) => ({
      reciboId: String(f.id), usuarioId: String(f.usuario_id), nombre: f.nombre, email: f.email, telefono: f.telefono,
      periodo: f.periodo, importe: Number(f.importe) || 0,
      devueltoEn: ms(f.devuelto_en), venceEn: venceDe(f.devuelto_en, margen), bloqueado: t > venceDe(f.devuelto_en, margen)
    }))
  };
}

/* Renovación automática (domiciliación): alarga 1 mes los abonos con
   auto_renovar=1 que acaban de caducar (hasta 7 días atrás: si lleva más,
   que pase por recepción) y emite el recibo 'pendiente'. Con un recibo
   DEVUELTO no se renueva: primero se regulariza en recepción. */
async function renovarVencidos(log) {
  log = log || (() => {});
  if (!bd.configurada()) return { renovados: 0 };
  const d = hoy();
  const corte = sumarDias(d, -7);
  const filas = await bd.consulta(
    `SELECT a.id FROM abonos a JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.activo = 1 AND a.auto_renovar = 1 AND a.hasta < ? AND a.hasta >= ? AND u.eliminado_en IS NULL`, [d, corte]);
  let renovados = 0;
  for (const fila of filas) {
    try {
      const r = await bd.enTransaccion(async (con) => {
        const [[a]] = await con.query('SELECT a.*, u.nombre FROM abonos a JOIN usuarios u ON u.id = a.usuario_id WHERE a.id = ? FOR UPDATE', [fila.id]);
        if (!a || !a.activo || !a.auto_renovar || String(a.hasta) >= d) return { saltado: true };
        const [[deuda]] = await con.query("SELECT id FROM recibos WHERE usuario_id = ? AND estado = 'devuelto' LIMIT 1", [a.usuario_id]);
        if (deuda) return { saltado: true };
        const precio = Number(await ajuste('abono_precio_mes', 18)) || 0;
        const nuevaHasta = sumarMeses(String(a.hasta), 1);
        await con.query('UPDATE abonos SET hasta = ? WHERE id = ?', [nuevaHasta, a.id]);
        await con.query("INSERT INTO abono_movimientos (abono_id, tipo, desde, hasta, importe, realizado_por) VALUES (?, 'renovacion_auto', ?, ?, ?, NULL)",
          [a.id, String(a.hasta), nuevaHasta, precio]);
        await crear(con, { usuarioId: a.usuario_id, abonoId: a.id, periodo: nuevaHasta, concepto: 'Mensualidad del abono (domiciliación)', importe: precio, metodo: 'domiciliacion', estado: 'pendiente' });
        await con.query("INSERT INTO registro_actividad (tipo, texto, actor_usuario_id, entidad, entidad_id) VALUES ('abono', ?, NULL, 'usuario', ?)",
          [`Renovación automática del abono de ${a.nombre} hasta el ${nuevaHasta}: recibo domiciliado de ${precio} € emitido.`, String(a.usuario_id)]);
        await con.query('INSERT INTO notificaciones (usuario_id, tipo, texto) VALUES (?, ?, ?)',
          [a.usuario_id, 'abono', `Tu abono se ha renovado hasta el ${nuevaHasta}. La mensualidad se pasa por el banco (domiciliación).`]);
        return { ok: true };
      });
      if (r.ok) renovados++;
    } catch (e) { log(`[recibos] renovación automática fallida (abono ${fila.id}): ${e.message}`); }
  }
  if (renovados) log(`[recibos] ${renovados} abono(s) renovados automáticamente con recibo domiciliado.`);
  return { renovados };
}

module.exports = { crear, marcar, recibosDe, impagos, renovarVencidos, margenDias, venceDe, MARGEN_POR_DEFECTO };
