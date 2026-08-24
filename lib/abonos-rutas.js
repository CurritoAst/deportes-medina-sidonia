/* ==========================================================================
   Deportes · Medina Sidonia — rutas de abonados/carnet (admin) y del socio
   ADMIN (rol admin):
     GET    /api/admin/usuarios?q=&rol=&abono=vigente|caducado|sin&pagina=
     GET    /api/admin/usuarios/:id
     POST   /api/admin/usuarios                 {nombre,email,telefono,rol,birthdate,claveTemporal?}
     PATCH  /api/admin/usuarios/:id             {nombre,telefono,birthdate}
     PATCH  /api/admin/usuarios/:id/rol         {rol}
     POST   /api/admin/usuarios/:id/verificar
     POST   /api/admin/usuarios/:id/clave       {claveTemporal?}   (sin clave → enlace por correo)
     DELETE /api/admin/usuarios/:id             (soft-delete anonimizado)
     POST   /api/admin/usuarios/:id/abono       {meses,autoRenovar,nfcUid?}
     POST   /api/admin/usuarios/:id/abono/baja
     PATCH  /api/admin/usuarios/:id/abono       {autoRenovar}
     PUT    /api/admin/usuarios/:id/carnet      {nfcUid, birthdate?}
     POST   /api/admin/usuarios/:id/carnet/liberar
     POST   /api/admin/usuarios/:id/carnet/rotar-qr
     GET    /api/admin/torno/lecturas-desconocidas   (últimos 5 min, modo alta de pulseras)
     GET    /api/admin/torno/estado
     POST   /api/admin/torno/validar            {lectura, direccion}  (registra con origen 'panel')
     GET    /api/admin/accesos?pagina=&usuario=
   SOCIO (sesión):
     GET    /api/mi/qr        lote de códigos (sin semilla)
     GET    /api/mi/accesos   últimos 50 propios
   ========================================================================== */

'use strict';

const bd = require('./bd');
const { responder, error } = require('./http');
const { vistaUsuarioAdmin, vistaUsuarioPropio } = require('./vistas');
const abonos = require('./abonos');
const recibosMod = require('./recibos');
const clave = require('./clave');
const sesion = require('./sesion');
const limite = require('./limite');
const correo = require('./correo');
const authRutas = require('./auth-rutas');
const tornoAuth = require('./torno-auth');
const token = require('./token');
const tornoRutas = require('./torno-rutas');
const { hoy, edad } = require('./fechas');
const uidMod = require('./uid');

const ahora = () => new Date();
const ID = { tipo: 'id' };

async function usuarioCompleto(id) {
  const u = await bd.uno('SELECT * FROM usuarios WHERE id = ?', [id]);
  if (!u) return null;
  const [a, c, rec] = await Promise.all([abonos.abonoDe(id), abonos.carnetDe(id), recibosMod.recibosDe(id, 6)]);
  const ab = abonos.vistaAbonoAdmin(a, c);
  const devuelto = rec.find((x) => x.estado === 'devuelto');
  if (ab && devuelto) ab.impago = { desde: devuelto.devueltoEn, vence: devuelto.venceEn };
  return Object.assign(vistaUsuarioAdmin(u), { abono: ab, recibos: rec });
}

async function anotar(tipo, texto, actorId, entidadId, ip) {
  await authRutas.registrar(tipo, texto, actorId, ip, 'usuario', entidadId);
}

function montar(router, { difundirAcceso } = {}) {
  const A = ['admin'];

  /* ---------- Listado y detalle ---------- */
  router.ruta('GET', '/api/admin/usuarios', A, { handler: async (ctx) => {
    const q = new URL(ctx.req.url, 'http://x').searchParams;
    const texto = String(q.get('q') || '').trim().slice(0, 80);
    const rol = ['vecino', 'monitor', 'admin'].includes(q.get('rol')) ? q.get('rol') : null;
    const filtroAbono = ['vigente', 'caducado', 'sin'].includes(q.get('abono')) ? q.get('abono') : null;
    const pagina = Math.max(1, Number(q.get('pagina')) || 1);
    const porPagina = 50;
    const cond = ['u.eliminado_en IS NULL'];
    const params = [];
    if (texto) { cond.push('(u.nombre LIKE ? OR u.email LIKE ? OR c.nfc_uid = ?)'); params.push(`%${texto}%`, `%${texto}%`, texto); }
    if (rol) { cond.push('u.rol = ?'); params.push(rol); }
    const d = hoy();
    if (filtroAbono === 'vigente') { cond.push('a.activo = 1 AND a.hasta >= ?'); params.push(d); }
    if (filtroAbono === 'caducado') { cond.push('a.id IS NOT NULL AND (a.activo = 0 OR a.hasta < ?)'); params.push(d); }
    if (filtroAbono === 'sin') cond.push('a.id IS NULL');
    const filas = await bd.consulta(
      `SELECT u.*, a.activo AS a_activo, a.desde AS a_desde, a.hasta AS a_hasta, a.auto_renovar AS a_auto,
              c.nfc_uid, c.nfc_id_legacy, c.qr_uid, c.revocado_en AS c_revocado, c.seed_rotada_en AS c_rotada,
              (SELECT MIN(r2.devuelto_en) FROM recibos r2 WHERE r2.usuario_id = u.id AND r2.estado = 'devuelto') AS impago_desde
         FROM usuarios u LEFT JOIN abonos a ON a.usuario_id = u.id LEFT JOIN carnets c ON c.usuario_id = u.id
        WHERE ${cond.join(' AND ')} ORDER BY u.nombre LIMIT ? OFFSET ?`, [...params, porPagina + 1, (pagina - 1) * porPagina]);
    const hayMas = filas.length > porPagina;
    const margen = await recibosMod.margenDias();
    const lista = filas.slice(0, porPagina).map((f) => {
      const ab = abonos.vistaAbonoAdmin(f.a_hasta ? { activo: f.a_activo, desde: f.a_desde, hasta: f.a_hasta, auto_renovar: f.a_auto } : null,
        f.qr_uid ? { nfc_uid: f.nfc_uid, nfc_id_legacy: f.nfc_id_legacy, qr_uid: f.qr_uid, revocado_en: f.c_revocado, seed_rotada_en: f.c_rotada } : null);
      if (ab && f.impago_desde) ab.impago = { desde: new Date(f.impago_desde).getTime(), vence: recibosMod.venceDe(f.impago_desde, margen) };
      return Object.assign(vistaUsuarioAdmin(f), { abono: ab });
    });
    responder(ctx.res, 200, { usuarios: lista, pagina, hayMas });
  } });

  router.ruta('GET', '/api/admin/usuarios/:id', A, { handler: async (ctx) => {
    const u = await usuarioCompleto(ctx.params.id);
    if (!u) return error(ctx.res, 404, 'Usuario no encontrado');
    const accesos = await bd.consulta('SELECT ts, metodo, resultado, motivo, direccion FROM accesos WHERE usuario_id = ? ORDER BY ts DESC LIMIT 20', [ctx.params.id]);
    responder(ctx.res, 200, { usuario: u, accesos: accesos.map((a) => ({ ts: new Date(a.ts).getTime(), metodo: a.metodo, resultado: a.resultado, motivo: a.motivo, direccion: a.direccion })) });
  } });

  /* ---------- Crear / editar / rol / verificar / clave / borrar ---------- */
  router.ruta('POST', '/api/admin/usuarios', A, {
    esquema: { nombre: { tipo: 'texto', largoMin: 3, largoMax: 120 }, email: { tipo: 'email' }, telefono: { tipo: 'texto', opcional: true, largoMax: 20 },
      rol: { tipo: 'enum', valores: ['vecino', 'monitor', 'admin'], opcional: true, porDefecto: 'vecino' }, birthdate: { tipo: 'fecha', opcional: true },
      claveTemporal: { tipo: 'texto', opcional: true, largoMax: 128 } },
    handler: async (ctx) => {
      const d = ctx.cuerpo;
      if (await bd.uno('SELECT id FROM usuarios WHERE email = ?', [d.email])) return error(ctx.res, 409, 'Ya existe una cuenta con ese correo.', { codigo: 'EMAIL_EN_USO' });
      let hash, debeCambiar = 0;
      if (d.claveTemporal) {
        const mal = clave.politicaClave(d.claveTemporal, { nombre: d.nombre, email: d.email });
        if (mal) return error(ctx.res, 400, mal, { campo: 'claveTemporal' });
        hash = await clave.hashear(d.claveTemporal); debeCambiar = 1;
      } else {
        hash = await clave.hashear(require('crypto').randomBytes(24).toString('base64url'));   // inutilizable hasta que restablezca
      }
      const r = await bd.consulta('INSERT INTO usuarios (email, nombre, telefono, fecha_nacimiento, rol, clave_hash, email_verificado_en, debe_cambiar_clave, acepta_normas_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [d.email, d.nombre, String(d.telefono || '').replace(/[\s.-]/g, ''), d.birthdate || null, d.rol, hash, ahora(), debeCambiar, ahora()]);
      const id = r.insertId;
      if (!d.claveTemporal) {
        const tok = await authRutas.emitirToken(id, 'invitacion', d.email, ctx.ip);
        const p = correo.plantillas().invitacion(d.nombre.split(' ')[0], tok);
        await correo.encolar({ para: d.email, asunto: p.asunto, texto: p.texto }).catch(() => {});
      }
      await anotar('usuarios', `Cuenta creada desde el panel: ${d.email} (${d.rol})${d.claveTemporal ? ' con clave temporal' : ' con invitación por correo'}.`, ctx.usuario.id, id, ctx.ip);
      responder(ctx.res, 201, { usuario: await usuarioCompleto(id) });
    } });

  router.ruta('PATCH', '/api/admin/usuarios/:id', A, {
    esquema: { nombre: { tipo: 'texto', largoMin: 3, largoMax: 120, opcional: true }, telefono: { tipo: 'texto', opcional: true, largoMax: 20 }, birthdate: { tipo: 'fecha', opcional: true } },
    handler: async (ctx) => {
      const u = await bd.uno('SELECT id FROM usuarios WHERE id = ? AND eliminado_en IS NULL', [ctx.params.id]);
      if (!u) return error(ctx.res, 404, 'Usuario no encontrado');
      const sets = [], params = [];
      if (ctx.cuerpo.nombre) { sets.push('nombre = ?'); params.push(ctx.cuerpo.nombre); }
      if (ctx.cuerpo.telefono !== undefined) { sets.push('telefono = ?'); params.push(String(ctx.cuerpo.telefono || '').replace(/[\s.-]/g, '')); }
      if (ctx.cuerpo.birthdate !== undefined) { sets.push('fecha_nacimiento = ?'); params.push(ctx.cuerpo.birthdate || null); }
      if (sets.length) { params.push(ctx.params.id); await bd.consulta(`UPDATE usuarios SET ${sets.join(', ')} WHERE id = ?`, params); }
      responder(ctx.res, 200, { usuario: await usuarioCompleto(ctx.params.id) });
    } });

  router.ruta('PATCH', '/api/admin/usuarios/:id/rol', A, { esquema: { rol: { tipo: 'enum', valores: ['vecino', 'monitor', 'admin'] } }, handler: async (ctx) => {
    const id = Number(ctx.params.id);
    if (id === ctx.usuario.id) return error(ctx.res, 400, 'No puedes cambiar tu propio rol.', { codigo: 'PROPIO' });
    const u = await bd.uno('SELECT id, rol, nombre FROM usuarios WHERE id = ? AND eliminado_en IS NULL', [id]);
    if (!u) return error(ctx.res, 404, 'Usuario no encontrado');
    if (u.rol === 'admin' && ctx.cuerpo.rol !== 'admin') {
      const n = await bd.uno("SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'admin' AND eliminado_en IS NULL");
      if (Number(n.n) <= 1) return error(ctx.res, 400, 'Debe quedar al menos un administrador.', { codigo: 'ULTIMO_ADMIN' });
    }
    await bd.consulta('UPDATE usuarios SET rol = ? WHERE id = ?', [ctx.cuerpo.rol, id]);
    await sesion.revocarTodas(id);
    await anotar('usuarios', `Rol de ${u.nombre} cambiado de ${u.rol} a ${ctx.cuerpo.rol}.`, ctx.usuario.id, id, ctx.ip);
    responder(ctx.res, 200, { usuario: await usuarioCompleto(id) });
  } });

  router.ruta('POST', '/api/admin/usuarios/:id/verificar', A, { handler: async (ctx) => {
    const r = await bd.consulta('UPDATE usuarios SET email_verificado_en = COALESCE(email_verificado_en, ?) WHERE id = ? AND eliminado_en IS NULL', [ahora(), ctx.params.id]);
    if (!r.affectedRows) return error(ctx.res, 404, 'Usuario no encontrado');
    await anotar('usuarios', `Correo verificado a mano por el admin (usuario ${ctx.params.id}).`, ctx.usuario.id, ctx.params.id, ctx.ip);
    responder(ctx.res, 200, { usuario: await usuarioCompleto(ctx.params.id) });
  } });

  router.ruta('POST', '/api/admin/usuarios/:id/clave', A, { esquema: { claveTemporal: { tipo: 'texto', opcional: true, largoMax: 128 } }, handler: async (ctx) => {
    const u = await bd.uno('SELECT id, nombre, email FROM usuarios WHERE id = ? AND eliminado_en IS NULL', [ctx.params.id]);
    if (!u) return error(ctx.res, 404, 'Usuario no encontrado');
    if (ctx.cuerpo.claveTemporal) {
      const mal = clave.politicaClave(ctx.cuerpo.claveTemporal, { nombre: u.nombre, email: u.email });
      if (mal) return error(ctx.res, 400, mal, { campo: 'claveTemporal' });
      await bd.consulta('UPDATE usuarios SET clave_hash = ?, clave_cambiada_en = ?, debe_cambiar_clave = 1, fallos_login = 0, bloqueado_hasta = NULL WHERE id = ?', [await clave.hashear(ctx.cuerpo.claveTemporal), ahora(), u.id]);
    } else {
      const tok = await authRutas.emitirToken(u.id, 'recuperar_clave', u.email, ctx.ip);
      const p = correo.plantillas().recuperar(u.nombre.split(' ')[0], tok);
      await correo.encolar({ para: u.email, asunto: p.asunto, texto: p.texto }).catch(() => {});
    }
    await sesion.revocarTodas(u.id);
    await anotar('usuarios', `Contraseña de ${u.nombre} restablecida por el admin (${ctx.cuerpo.claveTemporal ? 'clave temporal' : 'enlace por correo'}).`, ctx.usuario.id, u.id, ctx.ip);
    responder(ctx.res, 204);
  } });

  router.ruta('DELETE', '/api/admin/usuarios/:id', A, { handler: async (ctx) => {
    const id = Number(ctx.params.id);
    if (id === ctx.usuario.id) return error(ctx.res, 400, 'No puedes eliminar tu propia cuenta.', { codigo: 'PROPIO' });
    const u = await bd.uno('SELECT id, rol, nombre, email FROM usuarios WHERE id = ? AND eliminado_en IS NULL', [id]);
    if (!u) return error(ctx.res, 404, 'Usuario no encontrado');
    if (u.rol === 'admin') {
      const n = await bd.uno("SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'admin' AND eliminado_en IS NULL");
      if (Number(n.n) <= 1) return error(ctx.res, 400, 'No se puede eliminar al último administrador.', { codigo: 'ULTIMO_ADMIN' });
    }
    await bd.enTransaccion(async (con) => {
      await con.query("UPDATE usuarios SET eliminado_en = ?, email = CONCAT('borrado-', id, '@eliminado.local'), nombre = 'Usuario eliminado', telefono = '', fecha_nacimiento = NULL, clave_hash = 'x' WHERE id = ?", [ahora(), id]);
      await con.query('DELETE FROM sesiones WHERE usuario_id = ?', [id]);
      await con.query('DELETE FROM tokens_correo WHERE usuario_id = ?', [id]);
      await con.query('UPDATE abonos SET activo = 0, auto_renovar = 0, baja_en = ? WHERE usuario_id = ?', [ahora(), id]);
      await con.query('UPDATE carnets SET nfc_uid = NULL, revocado_en = ? WHERE usuario_id = ?', [ahora(), id]);
      await con.query("UPDATE reservas SET estado = 'cancelada', cancelada_en = ?, motivo_cancelacion = 'Cuenta eliminada' WHERE usuario_id = ? AND estado = 'confirmada' AND fecha >= ?", [ahora(), id, hoy()]);
      await con.query("UPDATE inscripciones_clase SET estado = 'baja', baja_en = ? WHERE usuario_id = ? AND estado IN ('inscrita','espera')", [ahora(), id]);
      await con.query('UPDATE gimnasio_inscripciones SET baja_en = ? WHERE usuario_id = ? AND baja_en IS NULL', [ahora(), id]);
    });
    await anotar('usuarios', `Cuenta eliminada (anonimizada): ${u.email}.`, ctx.usuario.id, id, ctx.ip);
    responder(ctx.res, 204);
  } });

  /* ---------- Abono y carnet ---------- */
  router.ruta('POST', '/api/admin/usuarios/:id/abono', A, {
    esquema: { meses: { tipo: 'entero', min: 1, max: 12, opcional: true, porDefecto: 1 }, autoRenovar: { tipo: 'bool', opcional: true, porDefecto: false }, nfcUid: { tipo: 'texto', opcional: true, largoMax: 20 } },
    handler: async (ctx) => {
      const r = await abonos.altaAbono({ usuarioId: Number(ctx.params.id), meses: ctx.cuerpo.meses, autoRenovar: ctx.cuerpo.autoRenovar, nfcUid: ctx.cuerpo.nfcUid, actorId: ctx.usuario.id, ip: ctx.ip });
      if (r.error) return error(ctx.res, r.codigo === 'NO_EXISTE' ? 404 : r.codigo === 'UID_EN_USO' ? 409 : 400, r.error, { codigo: r.codigo, de: r.de });
      responder(ctx.res, 200, { usuario: await usuarioCompleto(ctx.params.id) });
    } });
  router.ruta('POST', '/api/admin/usuarios/:id/abono/baja', A, { handler: async (ctx) => {
    const r = await abonos.bajaAbono({ usuarioId: Number(ctx.params.id), actorId: ctx.usuario.id, ip: ctx.ip });
    if (r.error) return error(ctx.res, 400, r.error, { codigo: r.codigo });
    responder(ctx.res, 200, { usuario: await usuarioCompleto(ctx.params.id) });
  } });
  router.ruta('PATCH', '/api/admin/usuarios/:id/abono', A, { esquema: { autoRenovar: { tipo: 'bool' } }, handler: async (ctx) => {
    const r = await abonos.autoRenovar({ usuarioId: Number(ctx.params.id), valor: ctx.cuerpo.autoRenovar, actorId: ctx.usuario.id });
    if (r.error) return error(ctx.res, 400, r.error, { codigo: r.codigo });
    responder(ctx.res, 200, { usuario: await usuarioCompleto(ctx.params.id) });
  } });
  router.ruta('PUT', '/api/admin/usuarios/:id/carnet', A, { esquema: { nfcUid: { tipo: 'texto', largoMax: 20 }, birthdate: { tipo: 'fecha', opcional: true } }, handler: async (ctx) => {
    const r = await abonos.asignarPulsera({ usuarioId: Number(ctx.params.id), nfcUid: ctx.cuerpo.nfcUid, birthdate: ctx.cuerpo.birthdate, actorId: ctx.usuario.id, ip: ctx.ip });
    if (r.error) return error(ctx.res, r.codigo === 'NO_EXISTE' ? 404 : r.codigo === 'UID_EN_USO' ? 409 : 400, r.error, { codigo: r.codigo, de: r.de });
    responder(ctx.res, 200, { usuario: await usuarioCompleto(ctx.params.id) });
  } });
  router.ruta('POST', '/api/admin/usuarios/:id/carnet/liberar', A, { handler: async (ctx) => {
    const r = await abonos.liberarPulsera({ usuarioId: Number(ctx.params.id), actorId: ctx.usuario.id, ip: ctx.ip });
    if (r.error) return error(ctx.res, 404, r.error, { codigo: r.codigo });
    responder(ctx.res, 200, { usuario: await usuarioCompleto(ctx.params.id) });
  } });
  router.ruta('POST', '/api/admin/usuarios/:id/carnet/rotar-qr', A, { handler: async (ctx) => {
    await abonos.rotarSeed({ usuarioId: Number(ctx.params.id), actorId: ctx.usuario.id, ip: ctx.ip });
    responder(ctx.res, 200, { usuario: await usuarioCompleto(ctx.params.id) });
  } });

  /* ---------- Torno desde el panel ---------- */
  router.ruta('GET', '/api/admin/torno/estado', A, { handler: async (ctx) => {
    const e = tornoAuth.estado;
    responder(ctx.res, 200, { nombre: e.nombre, ultimoContacto: e.ultimoContacto, version: e.version, enLinea: !!(e.ultimoContacto && Date.now() - e.ultimoContacto < 3 * 60e3), tokenConfigurado: tornoAuth.configurado() });
  } });
  router.ruta('GET', '/api/admin/torno/lecturas-desconocidas', A, { handler: async (ctx) => {
    const filas = await bd.consulta("SELECT ts, raw, direccion FROM accesos WHERE usuario_id IS NULL AND resultado = 'denegado' AND raw <> '' AND ts >= ? ORDER BY ts DESC LIMIT 20", [new Date(Date.now() - 5 * 60e3)]);
    responder(ctx.res, 200, { lecturas: filas.map((f) => ({ ts: new Date(f.ts).getTime(), raw: f.raw, direccion: f.direccion })) });
  } });
  /* Validación desde el panel (cámara/campo manual): misma lógica que la Pi, pero en servidor. */
  router.ruta('POST', '/api/admin/torno/validar', A, { esquema: { lectura: { tipo: 'texto', largoMax: 64 }, direccion: { tipo: 'enum', valores: ['entrada', 'salida'], opcional: true, porDefecto: 'entrada' } }, handler: async (ctx) => {
    // Acepta lo que escriba un lector USB (hex/decimal): se busca la pulsera por
    // su decimal (y la alternativa de orden de bytes). Los QR dinámicos son
    // numéricos largos y no se tocan.
    let v = ctx.cuerpo.lectura.trim();
    if (!token.esDinamico(v) && !/^\d+$/.test(v)) { const n = uidMod.normalizar(v); if (n.ok) v = n.principal; }
    const dir = ctx.cuerpo.direccion;
    const socios = await abonos.sociosParaTorno();
    const porUid = new Map(), porQr = new Map(), porNfcId = new Map();
    for (const s of socios) { if (s.nfcUid) porUid.set(s.nfcUid, s); porQr.set(s.qrUid, s); if (s.nfcId) porNfcId.set(s.nfcId, s); }
    let s = porUid.get(v) || porNfcId.get(v) || null, metodo = 'nfc', motivoQr = null;
    if (!s && token.esDinamico(v)) {
      metodo = 'qr';
      const r = token.validar(v, (uid) => (porQr.get(uid) ? porQr.get(uid).qrSeed : null));
      if (r.ok) s = porQr.get(r.uid); else motivoQr = r.motivo;
    }
    let resultado = 'denegado', motivo = motivoQr || 'Carnet no reconocido';
    const avisos = [];
    if (s) {
      if (dir === 'salida') { resultado = 'ok'; motivo = 'Salida registrada'; }
      else if (!s.activo) motivo = 'Abono dado de baja';
      else if (s.hasta < hoy()) motivo = `Abono caducado el ${s.hasta}`;
      else {
        const e = edad(s.birthdate); const min = Number(await abonos.ajuste('edad_minima', 16)) || 16;
        if (e !== null && e < min) motivo = `Acceso a partir de ${min} años`;
        else if (s.impago && Date.now() > s.impago.vence) motivo = 'Recibo devuelto sin pagar';   // plazo vencido
        else {
          resultado = 'ok'; motivo = 'Abono en vigor';
          if (s.impago) avisos.push('Recibo devuelto: pendiente de pago');                        // dentro del plazo: avisa
        }
      }
    }
    const r = await tornoRutas.registrarAcceso({ ts: Date.now(), metodo, resultado, motivo, direccion: dir, raw: v, avisos }, { origen: 'panel', dispositivo: 'panel' });
    if (!r.duplicado && difundirAcceso) difundirAcceso(r.evento);
    responder(ctx.res, 200, { resultado, motivo, direccion: dir, metodo, avisos, usuario: s ? { id: s.id, nombre: s.nombre } : null });
  } });

  /* ---------- Recibos e impagos (domiciliación) ---------- */
  router.ruta('GET', '/api/admin/impagos', A, { handler: async (ctx) => responder(ctx.res, 200, await recibosMod.impagos()) });
  router.ruta('POST', '/api/admin/recibos/:id/estado', A, {
    esquema: { estado: { tipo: 'enum', valores: ['pendiente', 'pagado', 'devuelto', 'anulado'] } },
    handler: async (ctx) => {
      const r = await recibosMod.marcar({ reciboId: Number(ctx.params.id), estado: ctx.cuerpo.estado, actorId: ctx.usuario.id, ip: ctx.ip });
      if (r.error) return error(ctx.res, r.codigo === 'NO_EXISTE' ? 404 : 400, r.error, { codigo: r.codigo });
      responder(ctx.res, 200, { ok: true, usuario: await usuarioCompleto(r.usuarioId) });
    } });
  /* Plazo general del impago: días desde «devuelto» hasta que el torno corta la entrada. */
  router.ruta('PATCH', '/api/admin/ajustes/impagos', A, {
    esquema: { margenDias: { tipo: 'entero', min: 0, max: 90 } },
    handler: async (ctx) => {
      await bd.consulta('INSERT INTO ajustes (clave, valor, actualizado_por) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor), actualizado_por = VALUES(actualizado_por)',
        ['impago_margen_dias', JSON.stringify(ctx.cuerpo.margenDias), ctx.usuario.id]);
      await anotar('finanzas', `Plazo de impago cambiado a ${ctx.cuerpo.margenDias} día(s) antes de cortar el torno.`, ctx.usuario.id, null, ctx.ip);
      responder(ctx.res, 200, { margenDias: ctx.cuerpo.margenDias });
    } });

  router.ruta('GET', '/api/admin/accesos', A, { handler: async (ctx) => {
    const q = new URL(ctx.req.url, 'http://x').searchParams;
    const pagina = Math.max(1, Number(q.get('pagina')) || 1);
    const usuario = q.get('usuario') ? Number(q.get('usuario')) : null;
    const cond = usuario ? 'WHERE a.usuario_id = ?' : '';
    const params = usuario ? [usuario] : [];
    const filas = await bd.consulta(`SELECT a.*, u.nombre FROM accesos a LEFT JOIN usuarios u ON u.id = a.usuario_id ${cond} ORDER BY a.ts DESC LIMIT 101 OFFSET ?`, [...params, (pagina - 1) * 100]);
    responder(ctx.res, 200, { pagina, hayMas: filas.length > 100, accesos: filas.slice(0, 100).map((a) => ({ id: a.id, ts: new Date(a.ts).getTime(), usuarioId: a.usuario_id ? String(a.usuario_id) : null, nombre: a.nombre || null, metodo: a.metodo, resultado: a.resultado, motivo: a.motivo, direccion: a.direccion, raw: a.raw, avisos: safeJson(a.avisos), origen: a.origen })) });
  } });

  /* ---------- El socio ---------- */
  router.ruta('GET', '/api/mi/qr', 'sesion', { handler: async (ctx) => {
    if (!limite.comprobar('qrSesion', ctx.sesion.hash).permitido) return error(ctx.res, 429, 'Demasiadas peticiones del QR.', { codigo: 'LIMITE' });
    const r = await abonos.loteQr(ctx.usuario.id);
    if (r.error) return error(ctx.res, 403, r.error, { codigo: r.codigo });
    responder(ctx.res, 200, r);
  } });
  router.ruta('GET', '/api/mi/accesos', 'sesion', { handler: async (ctx) => {
    const filas = await bd.consulta('SELECT ts, metodo, resultado, motivo, direccion FROM accesos WHERE usuario_id = ? ORDER BY ts DESC LIMIT 50', [ctx.usuario.id]);
    responder(ctx.res, 200, { accesos: filas.map((a) => ({ ts: new Date(a.ts).getTime(), metodo: a.metodo, resultado: a.resultado, motivo: a.motivo, direccion: a.direccion })) });
  } });
  router.ruta('GET', '/api/aforo', 'publico', { handler: async (ctx) => responder(ctx.res, 200, await tornoRutas.aforoHoy()) });
}

function safeJson(s) { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }

/* Amplía la vista del propio usuario con su abono y sus últimos recibos
   (para /api/auth/yo): el perfil avisa si el banco devolvió una mensualidad. */
async function extrasUsuario(usuarioId) {
  const [a, c, rec] = await Promise.all([abonos.abonoDe(usuarioId), abonos.carnetDe(usuarioId), recibosMod.recibosDe(usuarioId, 3).catch(() => [])]);
  return { abono: abonos.vistaAbonoPropio(a, c), recibos: rec.map((r) => ({ periodo: r.periodo, importe: r.importe, metodo: r.metodo, estado: r.estado, venceEn: r.venceEn })) };
}

module.exports = { montar, extrasUsuario, usuarioCompleto };
