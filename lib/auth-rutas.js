/* ==========================================================================
   Deportes · Medina Sidonia — rutas /api/auth/* (autenticación en servidor)
   Registro (con verificación por correo), login con bloqueo anti-fuerza-bruta,
   sesiones, perfil, cambio de clave, recuperación y restablecimiento.
   Decisiones (docs/DISENO-produccion-segura.md §3 + revisiones):
   · Registro: si el email existe SIN verificar, el nuevo registro SOBREESCRIBE
     nombre/teléfono/clave y reenvía el enlace (nadie ha probado propiedad aún).
     Si existe verificado, 202 igual y al dueño le llega "alguien lo intentó".
   · Login: scrypt SIEMPRE (hash dummy si no existe) → sin pista de tiempos;
     403 email_no_verificado SOLO si la clave era correcta; bloqueo por
     (email+IP) en memoria y bloqueo de cuenta en BD escalonado; el desbloqueo
     llega por correo (el admin nunca queda fuera más que lo que tarde en
     abrir el correo).
   · Verificar y restablecer borran TODAS las sesiones del usuario.
   · MSD_REGISTRO_ABIERTO=0 cierra el registro público (hasta F4) → 403.
   ========================================================================== */

'use strict';

const crypto = require('crypto');
const bd = require('./bd');
const clave = require('./clave');
const sesion = require('./sesion');
const limite = require('./limite');
const correo = require('./correo');
const { responder, error } = require('./http');
const { vistaUsuarioPropio } = require('./vistas');
const { esClaveDia } = require('./fechas');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nuevoToken = () => crypto.randomBytes(32).toString('base64url');
const ahora = () => new Date();
const mas = (ms) => new Date(Date.now() + ms);

const CADUCIDAD = { verificar_email: 24 * 3600e3, recuperar_clave: 3600e3, invitacion: 7 * 86400e3, desbloquear: 3600e3, cambiar_email: 24 * 3600e3 };
const MAX_FALLOS_CUENTA = 8;          // fallos seguidos → bloqueo de cuenta (persistente)
const BLOQUEO_MS = [15 * 60e3, 60 * 60e3];

const registroAbierto = () => process.env.MSD_REGISTRO_ABIERTO !== '0';

/* ---------- Utilidades de BD ---------- */
async function usuarioPorEmail(email) {
  return bd.uno('SELECT * FROM usuarios WHERE email = ? AND eliminado_en IS NULL', [email]);
}
async function usuarioPorId(id) {
  return bd.uno('SELECT * FROM usuarios WHERE id = ? AND eliminado_en IS NULL', [id]);
}
async function registrar(tipo, texto, actorId, ip, entidad, entidadId) {
  try {
    await bd.consulta('INSERT INTO registro_actividad (tipo, texto, actor_usuario_id, entidad, entidad_id, ip) VALUES (?, ?, ?, ?, ?, ?)',
      [tipo, String(texto).slice(0, 400), actorId || null, entidad || null, entidadId != null ? String(entidadId) : null, ip || null]);
  } catch (e) { console.error('[registro]', e.message); }
}

/* Emite un token de correo de un tipo (invalida los anteriores del mismo tipo). */
async function emitirToken(usuarioId, tipo, emailDestino, ip) {
  const token = nuevoToken();
  await bd.consulta('UPDATE tokens_correo SET usado_en = ? WHERE usuario_id = ? AND tipo = ? AND usado_en IS NULL', [ahora(), usuarioId, tipo]);
  await bd.consulta('INSERT INTO tokens_correo (usuario_id, tipo, token_hash, email_destino, expira_en, ip) VALUES (?, ?, ?, ?, ?, ?)',
    [usuarioId, tipo, sha256(token), emailDestino, mas(CADUCIDAD[tipo]), ip || null]);
  return token;
}
/* Busca un token vigente SIN consumirlo: devuelve la fila (con usuario) o null. */
async function buscarToken(token, tipos) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 128) return null;
  const fila = await bd.uno(
    `SELECT t.*, u.id AS uid FROM tokens_correo t JOIN usuarios u ON u.id = t.usuario_id
      WHERE t.token_hash = ? AND t.usado_en IS NULL AND t.expira_en > ? AND u.eliminado_en IS NULL`, [sha256(token), ahora()]);
  if (!fila || !tipos.includes(fila.tipo)) return null;
  return fila;
}
/* Marca un token como usado. Devuelve true si lo consumió (false si otro lo
   consumió antes: protege contra el doble envío). */
async function marcarUsado(id) {
  const r = await bd.consulta('UPDATE tokens_correo SET usado_en = ? WHERE id = ? AND usado_en IS NULL', [ahora(), id]);
  return !!(r && r.affectedRows);
}
/* Busca y consume en un paso (para flujos sin entrada del usuario, p. ej. verificar). */
async function consumirToken(token, tipos) {
  const fila = await buscarToken(token, tipos);
  if (!fila) return null;
  if (!(await marcarUsado(fila.id))) return null;
  return fila;
}

async function enviar(tipo, usuario, token) {
  const p = correo.plantillas();
  const nombre = usuario.nombre.split(' ')[0];
  const m = p[tipo](nombre, token);
  return correo.encolar({ para: usuario.email, asunto: m.asunto, texto: m.texto });
}

/* Extras del usuario (abono, gimnasio, clases…) que aportan otros módulos. Se
   registran con `anadirExtras(fn)` para no crear dependencias circulares. */
const proveedoresExtras = [];
function anadirExtras(fn) { proveedoresExtras.push(fn); }
async function extrasDe(usuarioId) {
  let out = {};
  for (const fn of proveedoresExtras) { try { Object.assign(out, await fn(usuarioId)); } catch (e) { console.error('[extras]', e.message); } }
  return out;
}

/* Contexto común para respuestas con sesión. */
async function responderConSesion(ctx, usuario, codigo) {
  await sesion.crear(ctx.req, ctx.res, usuario, { ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });
  responder(ctx.res, codigo || 200, { usuario: vistaUsuarioPropio(usuario, await extrasDe(usuario.id)), servidorMs: Date.now() });
}

/* ---------- Esquemas de entrada ---------- */
const TEL = /^(\+34)?[6-9]\d{8}$/;
const limpiarTel = (t) => String(t || '').replace(/[\s.-]/g, '');

const ESQ = {
  registro: {
    nombre: { tipo: 'texto', largoMin: 3, largoMax: 120 },
    email: { tipo: 'email' },
    telefono: { tipo: 'texto', opcional: true, largoMax: 20 },
    clave: { tipo: 'texto', largoMin: 1, largoMax: 128 },
    birthdate: { tipo: 'fecha', opcional: true },
    aceptaNormas: { tipo: 'bool' }
  },
  entrar: { email: { tipo: 'email' }, clave: { tipo: 'texto', largoMin: 1, largoMax: 128 } },
  soloEmail: { email: { tipo: 'email' } },
  soloToken: { token: { tipo: 'texto', largoMin: 20, largoMax: 128 } },
  perfil: { nombre: { tipo: 'texto', largoMin: 3, largoMax: 120 }, telefono: { tipo: 'texto', opcional: true, largoMax: 20 } },
  clave: { actual: { tipo: 'texto', largoMin: 1, largoMax: 128 }, nueva: { tipo: 'texto', largoMin: 1, largoMax: 128 } },
  restablecer: { token: { tipo: 'texto', largoMin: 20, largoMax: 128 }, clave: { tipo: 'texto', largoMin: 1, largoMax: 128 } }
};

function montar(router) {
  const R = (metodo, ruta, acceso, esquema, handler) => router.ruta(metodo, ruta, acceso, { esquema, handler, maxBytes: 10 * 1024 });

  /* ---- Registro ---- */
  R('POST', '/api/auth/registro', 'publico', ESQ.registro, async (ctx) => {
    if (!registroAbierto()) return error(ctx.res, 403, 'El registro online no está abierto todavía. Pásate por la oficina de deportes y te crean la cuenta.', { codigo: 'REGISTRO_CERRADO' });
    const ip = ctx.ip;
    if (!limite.comprobar('registroIp', ip).permitido) return error(ctx.res, 429, 'Demasiados registros desde esta conexión. Prueba más tarde.', { codigo: 'LIMITE' });
    const d = ctx.cuerpo;
    if (!d.aceptaNormas) return error(ctx.res, 400, 'Debes aceptar las normas de uso.', { campo: 'aceptaNormas' });
    const tel = limpiarTel(d.telefono);
    if (tel && !TEL.test(tel)) return error(ctx.res, 400, 'Escribe un móvil válido de 9 cifras.', { campo: 'telefono' });
    const mal = clave.politicaClave(d.clave, { nombre: d.nombre, email: d.email });
    if (mal) return error(ctx.res, 400, mal, { campo: 'clave' });

    // Hashear SIEMPRE antes de mirar si existe (anti-enumeración por tiempo)
    const hash = await clave.hashear(d.clave);
    const existente = await usuarioPorEmail(d.email);
    if (existente && existente.email_verificado_en) {
      await enviar('yaRegistrado', existente);
      await registrar('auth', `Intento de registro con correo ya existente: ${d.email}`, null, ip);
      return responder(ctx.res, 202, { ok: true });
    }
    let usuarioId;
    if (existente) {
      // sin verificar: nadie ha probado propiedad → se sobreescribe
      await bd.consulta('UPDATE usuarios SET nombre = ?, telefono = ?, fecha_nacimiento = ?, clave_hash = ?, acepta_normas_en = ? WHERE id = ?',
        [d.nombre, tel, d.birthdate || null, hash, ahora(), existente.id]);
      await sesion.revocarTodas(existente.id);
      usuarioId = existente.id;
    } else {
      const r = await bd.consulta('INSERT INTO usuarios (email, nombre, telefono, fecha_nacimiento, rol, clave_hash, acepta_normas_en) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [d.email, d.nombre, tel, d.birthdate || null, 'vecino', hash, ahora()]);
      usuarioId = r.insertId;
    }
    const u = await usuarioPorId(usuarioId);
    const token = await emitirToken(u.id, 'verificar_email', u.email, ip);
    await enviar('verificar', u, token);
    await registrar('auth', `Registro de ${u.email}; enviado correo de verificación`, null, ip, 'usuario', u.id);
    responder(ctx.res, 202, { ok: true });
  });

  /* ---- Verificar email ---- */
  R('POST', '/api/auth/verificar', 'publico', ESQ.soloToken, async (ctx) => {
    if (!limite.comprobar('tokenIp', ctx.ip).permitido) return error(ctx.res, 429, 'Demasiados intentos.', { codigo: 'LIMITE' });
    const t = await consumirToken(ctx.cuerpo.token, ['verificar_email']);
    if (!t) return error(ctx.res, 400, 'El enlace no es válido o ha caducado. Pide uno nuevo.', { codigo: 'TOKEN_INVALIDO' });
    await bd.consulta('UPDATE usuarios SET email_verificado_en = COALESCE(email_verificado_en, ?) WHERE id = ?', [ahora(), t.usuario_id]);
    await sesion.revocarTodas(t.usuario_id);
    const u = await usuarioPorId(t.usuario_id);
    await registrar('auth', `Correo verificado: ${u.email}`, u.id, ctx.ip, 'usuario', u.id);
    await responderConSesion(ctx, u, 200);
  });

  R('POST', '/api/auth/reenviar-verificacion', 'publico', ESQ.soloEmail, async (ctx) => {
    const email = ctx.cuerpo.email;
    if (!limite.comprobar('correoEmail', email).permitido || !limite.comprobar('correoIp', ctx.ip).permitido) {
      return error(ctx.res, 429, 'Ya hemos enviado varios correos. Espera un rato y revisa tu bandeja de spam.', { codigo: 'LIMITE' });
    }
    const u = await usuarioPorEmail(email);
    if (u && !u.email_verificado_en) {
      const token = await emitirToken(u.id, 'verificar_email', u.email, ctx.ip);
      await enviar('verificar', u, token);
    }
    responder(ctx.res, 202, { ok: true });   // siempre 202 (sin enumeración)
  });

  /* ---- Entrar ---- */
  R('POST', '/api/auth/entrar', 'publico', ESQ.entrar, async (ctx) => {
    const { email, clave: pass } = ctx.cuerpo;
    const ip = ctx.ip;
    if (!limite.comprobar('loginIp', ip).permitido) return error(ctx.res, 429, 'Demasiados intentos desde esta conexión. Espera unos minutos.', { codigo: 'LIMITE', reintentarEn: 60 }, { 'Retry-After': '60' });
    const cuboEmailIp = limite.comprobar('loginEmailIp', `${email}|${ip}`);
    if (!cuboEmailIp.permitido) return error(ctx.res, 429, 'Demasiados intentos. Espera unos minutos o usa "He olvidado mi contraseña".', { codigo: 'LIMITE', reintentarEn: cuboEmailIp.reintentarEn }, { 'Retry-After': String(cuboEmailIp.reintentarEn) });

    const u = await usuarioPorEmail(email);
    // bloqueo de cuenta persistente
    if (u && u.bloqueado_hasta && new Date(u.bloqueado_hasta) > ahora()) {
      return error(ctx.res, 423, 'Cuenta bloqueada temporalmente por demasiados intentos. Revisa tu correo: te hemos enviado un enlace para desbloquearla.', { codigo: 'BLOQUEADA', hasta: new Date(u.bloqueado_hasta).toISOString() });
    }
    // scrypt SIEMPRE (dummy si no existe) para no delatar cuentas por tiempo
    const v = u ? await clave.verificar(pass, u.clave_hash) : await clave.verificar(pass, await clave.hashDummy()).then(() => ({ ok: false }));
    if (!u || !v.ok) {
      if (u) {
        const fallos = (u.fallos_login || 0) + 1;
        let bloqueo = null;
        if (fallos >= MAX_FALLOS_CUENTA) {
          const nivel = Math.min(Math.floor(fallos / MAX_FALLOS_CUENTA) - 1, BLOQUEO_MS.length - 1);
          bloqueo = mas(BLOQUEO_MS[nivel]);
          // aviso + enlace de desbloqueo al dueño (evita el DoS del admin)
          try { const token = await emitirToken(u.id, 'desbloquear', u.email, ip); await enviar('desbloquear', u, token); } catch (e) { /* */ }
          await registrar('auth', `Cuenta bloqueada por ${fallos} fallos de acceso: ${u.email}`, null, ip, 'usuario', u.id);
        }
        await bd.consulta('UPDATE usuarios SET fallos_login = ?, bloqueado_hasta = ? WHERE id = ?', [Math.min(fallos, 255), bloqueo, u.id]);
      }
      return error(ctx.res, 401, 'Correo o contraseña incorrectos.', { codigo: 'CREDENCIALES' });
    }
    if (!u.email_verificado_en) {
      return error(ctx.res, 403, 'Todavía no has confirmado tu correo. Revisa tu bandeja (y el spam) o pide que te lo reenviemos.', { codigo: 'EMAIL_NO_VERIFICADO' });
    }
    // éxito: reset de fallos, rehash si toca, último login
    const sets = ['fallos_login = 0', 'bloqueado_hasta = NULL', 'ultimo_login_en = ?'];
    const params = [ahora()];
    if (v.rehash) { sets.push('clave_hash = ?'); params.push(await clave.hashear(pass)); }
    params.push(u.id);
    await bd.consulta(`UPDATE usuarios SET ${sets.join(', ')} WHERE id = ?`, params);
    limite.limpiar(`loginEmailIp:${email}|${ip}`);
    await responderConSesion(ctx, u, 200);
  });

  /* ---- Salir ---- */
  R('POST', '/api/auth/salir', 'sesion', null, async (ctx) => {
    await sesion.cerrar(ctx.req, ctx.res, ctx.sesion);
    responder(ctx.res, 204);
  });
  R('POST', '/api/auth/salir-todas', 'sesion', null, async (ctx) => {
    await sesion.revocarTodas(ctx.usuario.id);
    await sesion.cerrar(ctx.req, ctx.res, null);
    responder(ctx.res, 204);
  });

  /* ---- Yo ---- */
  router.ruta('GET', '/api/auth/yo', 'sesion', { handler: async (ctx) => {
    const sinLeer = await bd.uno('SELECT COUNT(*) AS n FROM notificaciones WHERE usuario_id = ? AND leida_en IS NULL', [ctx.usuario.id]).catch(() => ({ n: 0 }));
    responder(ctx.res, 200, { usuario: vistaUsuarioPropio(ctx.usuario, await extrasDe(ctx.usuario.id)), sinLeer: Number(sinLeer && sinLeer.n) || 0, servidorMs: Date.now() });
  } });

  /* ---- Perfil ---- */
  router.ruta('PATCH', '/api/auth/perfil', 'sesion', { esquema: ESQ.perfil, handler: async (ctx) => {
    const tel = limpiarTel(ctx.cuerpo.telefono);
    if (tel && !TEL.test(tel)) return error(ctx.res, 400, 'Escribe un móvil válido de 9 cifras.', { campo: 'telefono' });
    await bd.consulta('UPDATE usuarios SET nombre = ?, telefono = ? WHERE id = ?', [ctx.cuerpo.nombre, tel, ctx.usuario.id]);
    const u = await usuarioPorId(ctx.usuario.id);
    responder(ctx.res, 200, { usuario: vistaUsuarioPropio(u) });
  } });

  /* ---- Cambiar contraseña ---- */
  R('POST', '/api/auth/clave', 'sesion', ESQ.clave, async (ctx) => {
    const u = await usuarioPorId(ctx.usuario.id);
    const v = await clave.verificar(ctx.cuerpo.actual, u.clave_hash);
    if (!v.ok) return error(ctx.res, 400, 'La contraseña actual no es correcta.', { campo: 'actual' });
    const mal = clave.politicaClave(ctx.cuerpo.nueva, { nombre: u.nombre, email: u.email });
    if (mal) return error(ctx.res, 400, mal, { campo: 'nueva' });
    await bd.consulta('UPDATE usuarios SET clave_hash = ?, clave_cambiada_en = ?, debe_cambiar_clave = 0 WHERE id = ?', [await clave.hashear(ctx.cuerpo.nueva), ahora(), u.id]);
    await sesion.revocarTodas(u.id, ctx.sesion.hash);   // conserva la actual
    await enviar('claveCambiada', u).catch(() => {});
    await registrar('auth', `Cambio de contraseña: ${u.email}`, u.id, ctx.ip, 'usuario', u.id);
    responder(ctx.res, 204);
  });

  /* ---- Recuperar / restablecer ---- */
  R('POST', '/api/auth/recuperar', 'publico', ESQ.soloEmail, async (ctx) => {
    const email = ctx.cuerpo.email;
    if (!limite.comprobar('correoEmail', email).permitido || !limite.comprobar('correoIp', ctx.ip).permitido) {
      return error(ctx.res, 429, 'Ya hemos enviado varios correos. Espera un rato y revisa tu bandeja de spam.', { codigo: 'LIMITE' });
    }
    responder(ctx.res, 202, { ok: true });   // responde ya; el trabajo sigue (sin enumeración por tiempo)
    const u = await usuarioPorEmail(email);
    if (u) {
      const token = await emitirToken(u.id, 'recuperar_clave', u.email, ctx.ip);
      await enviar('recuperar', u, token);
      await registrar('auth', `Solicitud de recuperación de contraseña: ${u.email}`, null, ctx.ip, 'usuario', u.id);
    }
  });

  R('POST', '/api/auth/restablecer', 'publico', ESQ.restablecer, async (ctx) => {
    if (!limite.comprobar('tokenIp', ctx.ip).permitido) return error(ctx.res, 429, 'Demasiados intentos.', { codigo: 'LIMITE' });
    // 1) Buscar el token SIN consumirlo: si la contraseña no pasa la política, el
    //    enlace sigue valiendo (si no, un error de tecleo dejaría al usuario sin enlace).
    const t = await buscarToken(ctx.cuerpo.token, ['recuperar_clave', 'invitacion', 'desbloquear']);
    if (!t) return error(ctx.res, 400, 'El enlace no es válido o ha caducado. Pide uno nuevo.', { codigo: 'TOKEN_INVALIDO' });
    const u = await usuarioPorId(t.usuario_id);
    const mal = clave.politicaClave(ctx.cuerpo.clave, { nombre: u.nombre, email: u.email });
    if (mal) return error(ctx.res, 400, mal, { campo: 'clave' });
    const hash = await clave.hashear(ctx.cuerpo.clave);
    // 2) Consumir el token (un solo uso) y aplicar el cambio.
    if (!(await marcarUsado(t.id))) return error(ctx.res, 400, 'El enlace ya se ha usado. Pide uno nuevo.', { codigo: 'TOKEN_INVALIDO' });
    // probar el correo = probar propiedad → verificado si no lo estaba; desbloquea; revoca todo
    await bd.consulta('UPDATE usuarios SET clave_hash = ?, clave_cambiada_en = ?, debe_cambiar_clave = 0, fallos_login = 0, bloqueado_hasta = NULL, email_verificado_en = COALESCE(email_verificado_en, ?) WHERE id = ?',
      [hash, ahora(), ahora(), u.id]);
    await sesion.revocarTodas(u.id);
    if (t.tipo !== 'invitacion') await enviar('claveCambiada', u).catch(() => {});
    await registrar('auth', `Contraseña restablecida (${t.tipo}): ${u.email}`, u.id, ctx.ip, 'usuario', u.id);
    const u2 = await usuarioPorId(u.id);
    await responderConSesion(ctx, u2, 200);
  });
}

/* Crea el primer admin si no existe ninguno y hay variables de bootstrap.
   Devuelve true si lo creó. */
async function bootstrapAdmin(log) {
  log = log || (() => {});
  const email = String(process.env.MSD_BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
  const pass = process.env.MSD_BOOTSTRAP_ADMIN_CLAVE || '';
  if (!email || !pass) return false;
  const hay = await bd.uno("SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'admin' AND eliminado_en IS NULL");
  if (hay && Number(hay.n) > 0) { log('[bootstrap] ya existe un admin: se ignoran MSD_BOOTSTRAP_ADMIN_* (puedes borrar esas variables)'); return false; }
  if (pass.length < 12) { log('[bootstrap] MSD_BOOTSTRAP_ADMIN_CLAVE debe tener al menos 12 caracteres: no se crea el admin'); return false; }
  const nombre = String(process.env.MSD_BOOTSTRAP_ADMIN_NOMBRE || 'Administración Deportes').slice(0, 120);
  const hash = await clave.hashear(pass);
  const r = await bd.consulta('INSERT INTO usuarios (email, nombre, rol, clave_hash, email_verificado_en, debe_cambiar_clave, acepta_normas_en) VALUES (?, ?, ?, ?, ?, 1, ?)',
    [email, nombre, 'admin', hash, ahora(), ahora()]);
  await registrar('sistema', `Admin inicial creado por bootstrap: ${email} (debe cambiar la contraseña)`, null, null, 'usuario', r.insertId);
  log(`[bootstrap] ADMIN CREADO: ${email}. Entra, cambia la contraseña y BORRA las variables MSD_BOOTSTRAP_ADMIN_* del panel.`);
  return true;
}

module.exports = { montar, bootstrapAdmin, emitirToken, consumirToken, buscarToken, marcarUsado, usuarioPorEmail, usuarioPorId, registrar, anadirExtras, extrasDe };
