/* ==========================================================================
   Deportes · Medina Sidonia — usuarios, sesión, abonos y automatización
   Módulo compartido por la web pública (index.html) y el panel (admin.html).

   NOTA DE PROTOTIPO: la autenticación vive en localStorage con contraseñas
   con hash+sal. Es una demo funcional; en producción esto sería un backend
   con sesiones de servidor.
   ========================================================================== */

const MSDAuth = (function () {
  'use strict';

  const CLAVES = {
    usuarios: 'msd_usuarios',
    sesion: 'msd_sesion',
    accesos: 'msd_accesos',
    automatizaciones: 'msd_automatizaciones',
    notificaciones: 'msd_notificaciones',
    semilla: 'msd_semilla_v1'
  };

  const leer = (clave, porDefecto) => {
    try {
      const bruto = localStorage.getItem(clave);
      const valor = bruto ? JSON.parse(bruto) : porDefecto;
      return valor === null || valor === undefined ? porDefecto : valor;
    } catch (e) { return porDefecto; }
  };

  const guardar = (clave, valor) => {
    try { localStorage.setItem(clave, JSON.stringify(valor)); } catch (e) { /* sin persistencia */ }
    if (typeof MSDSync !== 'undefined') MSDSync.empujar(clave);
  };

  const pad2 = (n) => String(n).padStart(2, '0');
  const claveDia = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const hoy = () => claveDia(new Date());

  const sumarMes = (claveFecha) => {
    const [a, m, d] = claveFecha.split('-').map(Number);
    // Día equivalente del mes siguiente, sin desbordar (31 ene → 28/29 feb)
    const ultimoDia = new Date(a, m + 1, 0).getDate();
    return claveDia(new Date(a, m, Math.min(d, ultimoDia)));
  };

  /* ---------- Hash de contraseñas ---------- */

  async function hashTexto(texto) {
    if (window.crypto && crypto.subtle) {
      const datos = new TextEncoder().encode(texto);
      const resumen = await crypto.subtle.digest('SHA-256', datos);
      return Array.from(new Uint8Array(resumen)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    // Alternativa simple si no hay SubtleCrypto (solo demo)
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < texto.length; i++) {
      h1 = Math.imul(h1 ^ texto.charCodeAt(i), 0x01000193) >>> 0;
      h2 = Math.imul(h2 + texto.charCodeAt(i), 0x85ebca6b) >>> 0;
    }
    return h1.toString(16) + h2.toString(16);
  }

  const nuevaSal = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);

  /* ---------- Saneado de usuarios ---------- */

  function saneaUsuarios(lista) {
    if (!Array.isArray(lista)) return [];
    const emails = new Set();
    return lista.filter((u) => {
      const ok = u && typeof u === 'object'
        && typeof u.id === 'string' && /^u-[a-z0-9]+$/.test(u.id)
        && typeof u.email === 'string' && u.email.length <= 120
        && typeof u.nombre === 'string' && u.nombre.length <= 120
        && typeof u.hash === 'string' && typeof u.sal === 'string'
        && (u.rol === 'vecino' || u.rol === 'monitor' || u.rol === 'admin')
        && !emails.has(u.email.toLowerCase());
      if (ok) emails.add(u.email.toLowerCase());
      return ok;
    }).map((u) => ({
      ...u,
      telefono: typeof u.telefono === 'string' ? u.telefono.slice(0, 20) : '',
      // Fecha de nacimiento para el control de edad mínima del torno (16 años).
      birthdate: (typeof u.birthdate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(u.birthdate)) ? u.birthdate : '',
      abono: saneaAbono(u.abono)
    }));
  }

  function saneaAbono(a) {
    if (!a || typeof a !== 'object') return null;
    if (typeof a.hasta !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a.hasta)) return null;
    const nfcId = (typeof a.nfcId === 'string' && /^NFC-[A-Z0-9]{8}$/.test(a.nfcId)) ? a.nfcId : null;
    // UID real de la tarjeta física / pulsera: decimal de 6 a 20 dígitos
    // (el lector HM20 entrega ~10 dígitos por NFC).
    const nfcUid = (typeof a.nfcUid === 'string' && /^\d{6,20}$/.test(a.nfcUid)) ? a.nfcUid : null;
    // Semilla secreta para el QR dinámico (hex de 16 a 64 caracteres).
    const qrSeed = (typeof a.qrSeed === 'string' && /^[0-9a-f]{16,64}$/.test(a.qrSeed)) ? a.qrSeed : null;
    // Un abono válido necesita al menos un identificador de acceso.
    if (!nfcId && !nfcUid) return null;
    return {
      activo: a.activo === true,
      desde: typeof a.desde === 'string' ? a.desde : hoy(),
      hasta: a.hasta,
      autoRenovar: a.autoRenovar === true,
      nfcId,
      nfcUid,
      qrSeed
    };
  }

  function saneaAccesos(lista) {
    if (!Array.isArray(lista)) return [];
    return lista.filter((a) => a && typeof a === 'object'
      && Number.isFinite(a.ts)
      && (a.metodo === 'qr' || a.metodo === 'nfc')
      && (a.resultado === 'ok' || a.resultado === 'denegado')
      && typeof a.motivo === 'string' && a.motivo.length <= 120
      && (a.usuarioId === null || typeof a.usuarioId === 'string')).slice(0, 300)
      .map((a) => ({
        ts: a.ts,
        usuarioId: a.usuarioId,
        metodo: a.metodo,
        resultado: a.resultado,
        motivo: a.motivo,
        // Sentido del paso: entrada o salida (por defecto entrada, para datos antiguos).
        direccion: (a.direccion === 'salida') ? 'salida' : 'entrada',
        // Valor crudo leído por el lector (UID o payload del QR), para auditoría.
        raw: (typeof a.raw === 'string') ? a.raw.slice(0, 64) : ''
      }));
  }

  function saneaAutomatizaciones(lista) {
    if (!Array.isArray(lista)) return [];
    return lista.filter((a) => a && typeof a === 'object'
      && Number.isFinite(a.ts)
      && typeof a.tipo === 'string' && a.tipo.length <= 30
      && typeof a.texto === 'string' && a.texto.length <= 400).slice(0, 200);
  }

  function saneaNotificaciones(lista) {
    if (!Array.isArray(lista)) return [];
    return lista.filter((n) => n && typeof n === 'object'
      && typeof n.usuarioId === 'string'
      && Number.isFinite(n.ts)
      && typeof n.texto === 'string' && n.texto.length <= 300
      && typeof n.leida === 'boolean').slice(0, 400);
  }

  let usuarios = saneaUsuarios(leer(CLAVES.usuarios, []));
  let accesos = saneaAccesos(leer(CLAVES.accesos, []));
  let automatizaciones = saneaAutomatizaciones(leer(CLAVES.automatizaciones, []));
  let notificaciones = saneaNotificaciones(leer(CLAVES.notificaciones, []));

  const persistirUsuarios = () => guardar(CLAVES.usuarios, usuarios);

  /* ---------- Registro de automatizaciones (visible en el panel) ---------- */

  /* ---------- Notificaciones por usuario (la campana) ---------- */

  function notificar(usuarioId, texto) {
    notificaciones.unshift({ usuarioId, ts: Date.now(), texto: String(texto).slice(0, 300), leida: false });
    notificaciones = notificaciones.slice(0, 400);
    guardar(CLAVES.notificaciones, notificaciones);
  }

  const notificacionesDe = (usuarioId) =>
    notificaciones.filter((n) => n.usuarioId === usuarioId);

  function marcarLeidas(usuarioId) {
    let cambio = false;
    notificaciones.forEach((n) => {
      if (n.usuarioId === usuarioId && !n.leida) { n.leida = true; cambio = true; }
    });
    if (cambio) guardar(CLAVES.notificaciones, notificaciones);
  }

  function anotarAutomatizacion(tipo, texto) {
    automatizaciones.unshift({ ts: Date.now(), tipo, texto });
    automatizaciones = automatizaciones.slice(0, 200);
    guardar(CLAVES.automatizaciones, automatizaciones);
  }

  /* ---------- Datos de demostración (primera ejecución) ---------- */

  async function sembrar() {
    if (leer(CLAVES.semilla, false)) return;

    const crear = async (nombre, email, telefono, clave, rol, abono, birthdate) => {
      const sal = nuevaSal();
      return {
        id: `u-${Math.random().toString(36).slice(2, 10)}`,
        nombre, email, telefono, rol,
        sal,
        hash: await hashTexto(sal + clave),
        creado: Date.now(),
        birthdate: birthdate || '',
        abono
      };
    };

    const enUnMes = sumarMes(hoy());
    const caducado = '2026-07-10';

    const demo = [
      await crear('Administración Deportes', 'admin@medinasidonia.es', '956410005', 'MedinaAdmin2026', 'admin', null, ''),
      // nfcUid de Carmen: UID real capturado del lector del torno (ejemplo del documento).
      await crear('Carmen Aragón Vela', 'carmen@correo.es', '600111222', 'Vecina2026', 'vecino',
        { activo: true, desde: hoy(), hasta: enUnMes, autoRenovar: true, nfcId: 'NFC-C4RM3N01', nfcUid: '1399878112', qrSeed: 'a1b2c3d4e5f60001' }, '1985-04-12'),
      await crear('Paco Reyes Butrón', 'paco@correo.es', '611222333', 'Vecino2026', 'vecino',
        { activo: true, desde: hoy(), hasta: enUnMes, autoRenovar: false, nfcId: 'NFC-P4C0RY02', nfcUid: '0642119837', qrSeed: 'a1b2c3d4e5f60002' }, '1978-09-03'),
      await crear('Lucía Barea Pina', 'lucia@correo.es', '622333444', 'Vecina2026', 'vecino',
        { activo: true, desde: '2026-06-10', hasta: caducado, autoRenovar: false, nfcId: 'NFC-LUC14B03', nfcUid: '1770233945', qrSeed: 'a1b2c3d4e5f60003' }, '1990-11-21')
    ];

    usuarios = usuarios.concat(demo.filter((d) => !buscarPorEmail(d.email)));
    persistirUsuarios();

    // Un par de accesos de ejemplo para que el torno no arranque vacío
    const ahora = Date.now();
    accesos = [
      { ts: ahora - 3600e3 * 2, usuarioId: demo[1].id, metodo: 'nfc', resultado: 'ok', motivo: 'Abono en vigor', direccion: 'entrada', raw: '1399878112' },
      { ts: ahora - 3600e3, usuarioId: demo[2].id, metodo: 'qr', resultado: 'ok', motivo: 'Abono en vigor', direccion: 'entrada', raw: '' }
    ];
    guardar(CLAVES.accesos, accesos);

    anotarAutomatizacion('sistema', 'Puesta en marcha: usuarios y abonos de demostración creados.');
    guardar(CLAVES.semilla, true);
  }

  /* ---------- Consultas ---------- */

  const buscarPorEmail = (email) =>
    usuarios.find((u) => u.email.toLowerCase() === String(email).trim().toLowerCase());

  const buscarPorId = (id) => usuarios.find((u) => u.id === id);

  const buscarPorNfc = (nfcId) =>
    usuarios.find((u) => u.abono && u.abono.nfcId === nfcId);

  const buscarPorNfcUid = (uid) =>
    usuarios.find((u) => u.abono && u.abono.nfcUid === uid);

  /* Busca por cualquier identificador que llegue del lector: UID real de la
     tarjeta/pulsera o el nfcId legado. */
  const buscarPorIdentificador = (ident) =>
    usuarios.find((u) => u.abono && (u.abono.nfcUid === ident || u.abono.nfcId === ident));

  /* Edad cumplida a fecha `ref` (o hoy). Devuelve null si no hay fecha. */
  function edadEn(birthdate, ref) {
    if (!birthdate || !/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) return null;
    const [a, m, d] = birthdate.split('-').map(Number);
    const r = ref || new Date();
    let e = r.getFullYear() - a;
    const yaCumplio = (r.getMonth() + 1 > m) || (r.getMonth() + 1 === m && r.getDate() >= d);
    if (!yaCumplio) e -= 1;
    return e;
  }

  /* ==========================================================================
     SESIÓN EN SERVIDOR (F2)
     La cuenta vive en el servidor: cookie HttpOnly + /api/auth/*. Aquí solo se
     cachea el usuario que el servidor dice que somos (`yo`). El resto de
     almacenes legados (abonos, accesos, tarifas…) siguen en localStorage hasta
     que cada pantalla migre (F3–F6). Si el servidor no tiene API de cuentas
     (abierto con doble clic o sin BD), se cae al modo local antiguo.
     ========================================================================== */

  const hayApi = typeof MSDApi !== 'undefined' && (location.protocol === 'http:' || location.protocol === 'https:');
  let yo = null;                 // usuario del servidor (forma de vistaUsuarioPropio)
  let modoServidor = false;      // true cuando /api/auth responde (hay BD)

  /* Usuario de servidor con la forma que esperan las pantallas. El abono viene
     del servidor (F3) con la misma forma que el legado (activo/desde/hasta/
     autoRenovar) más `nfcUltimos4`/`tienePulsera`; el UID completo y la
     semilla del QR NO llegan al navegador. */
  function usuarioFusionado(y) {
    if (!y) return null;
    const ab = y.abono ? {
      activo: !!y.abono.activo, desde: y.abono.desde, hasta: y.abono.hasta, autoRenovar: !!y.abono.autoRenovar,
      vigente: !!y.abono.vigente, nfcUltimos4: y.abono.nfcUltimos4 || null, tienePulsera: !!y.abono.tienePulsera,
      // compatibilidad con htmlCarnet: muestra '···1234' en vez del UID completo
      nfcUid: y.abono.nfcUltimos4 ? '···' + y.abono.nfcUltimos4 : null, nfcId: null, qrSeed: null, qrUid: y.abono.qrUid || null,
      servidor: true
    } : null;
    return Object.assign({ birthdate: '', telefono: '' }, y, { id: y.id, rol: y.rol, nombre: y.nombre, email: y.email, abono: ab });
  }

  /* ---------- QR del carnet en modo servidor (lote de códigos, sin semilla) ---------- */
  let loteQr = null;          // { qrUid, desdeT, ventana, codigos, servidorMs, pedidoEnLocal }
  let pidiendoLote = null;
  const LOTE_CLAVE = 'msd_qr_lote';
  try { loteQr = JSON.parse(localStorage.getItem(LOTE_CLAVE) || 'null'); } catch (e) { loteQr = null; }

  function ventanaActualServidor() {
    const offset = loteQr ? (loteQr.servidorMs - loteQr.pedidoEnLocal) : 0;   // reloj del servidor − reloj local
    return Math.floor((Date.now() + offset) / 1000 / (loteQr ? loteQr.ventana : 30));
  }
  async function pedirLoteQr() {
    if (pidiendoLote) return pidiendoLote;
    pidiendoLote = (async () => {
      const r = await MSDApi.get('/api/mi/qr');
      if (r.ok) {
        loteQr = Object.assign({}, r.datos, { pedidoEnLocal: Date.now() });
        try { localStorage.setItem(LOTE_CLAVE, JSON.stringify(loteQr)); } catch (e) { /* */ }
      } else if (r.status === 403) {
        loteQr = null; try { localStorage.removeItem(LOTE_CLAVE); } catch (e) { /* */ }
      }
      pidiendoLote = null;
      return loteQr;
    })();
    return pidiendoLote;
  }
  /* Prefetch: al entrar con abono vigente, al volver a la pestaña y al recuperar red,
     para que en la puerta haya QR aunque el móvil se quede sin cobertura. */
  function prefetchLote() { if (modoServidor && yo && yo.abono && yo.abono.vigente) pedirLoteQr().catch(() => {}); }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') prefetchLote(); });
    window.addEventListener('online', prefetchLote);
  }

  function sesionActual() {
    if (modoServidor) return usuarioFusionado(yo);
    // modo local (sin API): comportamiento antiguo
    const s = leer(CLAVES.sesion, null);
    if (!s || typeof s.usuarioId !== 'string') return null;
    return buscarPorId(s.usuarioId) || null;
  }

  /* Pregunta al servidor quién soy (cookie). Devuelve true si hay API. */
  async function cargarYo() {
    if (!hayApi) return false;
    const r = await MSDApi.get('/api/auth/yo');
    if (r.status === 503 || r.sinRed) return false;       // sin BD / sin red: modo local
    modoServidor = true;
    yo = r.ok ? r.datos.usuario : null;
    if (r.ok) prefetchLote();
    return true;
  }
  /* Refresca `yo` desde el servidor (tras cambios que afecten al abono, etc.). */
  async function recargarYo() {
    if (!modoServidor) return null;
    const r = await MSDApi.get('/api/auth/yo');
    if (r.ok) { yo = r.datos.usuario; prefetchLote(); }
    else if (r.status === 401) yo = null;
    return usuarioFusionado(yo);
  }

  /* ---------- Registro / entrada / salida ---------- */

  /* Registro: el servidor envía un correo de verificación. Devuelve
     { pendienteVerificacion:true } (no inicia sesión) o { error, campo }. */
  async function registrar({ nombre, email, telefono, clave, birthdate }) {
    if (modoServidor) {
      const r = await MSDApi.post('/api/auth/registro', { nombre, email, telefono: telefono || '', clave, birthdate: birthdate || undefined, aceptaNormas: true });
      if (!r.ok) return { error: r.error, campo: r.campo, codigo: r.codigo };
      return { pendienteVerificacion: true, email: String(email).trim().toLowerCase() };
    }
    // modo local antiguo (sin servidor)
    if (buscarPorEmail(email)) return { error: 'Ya existe una cuenta con ese correo. Prueba a iniciar sesión.' };
    const sal = nuevaSal();
    const usuario = { id: `u-${Math.random().toString(36).slice(2, 10)}`, nombre: nombre.trim().slice(0, 120), email: email.trim().slice(0, 120), telefono: (telefono || '').trim().slice(0, 20), rol: 'vecino', sal, hash: await hashTexto(sal + clave), creado: Date.now(), abono: null };
    usuarios.push(usuario); persistirUsuarios();
    guardar(CLAVES.sesion, { usuarioId: usuario.id, desde: Date.now() });
    return { usuario };
  }

  async function entrar(email, clave) {
    if (modoServidor) {
      const r = await MSDApi.post('/api/auth/entrar', { email, clave });
      if (!r.ok) return { error: r.error, codigo: r.codigo, campo: r.codigo === 'CREDENCIALES' ? 'clave' : undefined, hasta: r.datos && r.datos.hasta };
      yo = r.datos.usuario;
      return { usuario: usuarioFusionado(yo) };
    }
    const u = buscarPorEmail(email);
    if (!u) return { error: 'No hay ninguna cuenta con ese correo.', campo: 'email' };
    const hash = await hashTexto(u.sal + clave);
    if (hash !== u.hash) return { error: 'La contraseña no es correcta.', campo: 'clave' };
    guardar(CLAVES.sesion, { usuarioId: u.id, desde: Date.now() });
    return { usuario: u };
  }

  function salir() {
    if (modoServidor) { yo = null; loteQr = null; try { localStorage.removeItem(LOTE_CLAVE); } catch (e) { /* */ } MSDApi.post('/api/auth/salir').catch(() => {}); }
    localStorage.removeItem(CLAVES.sesion);
  }

  /* Verificación de correo y recuperación (solo servidor). */
  async function verificarCorreo(token) {
    const r = await MSDApi.post('/api/auth/verificar', { token });
    if (!r.ok) return { error: r.error, codigo: r.codigo };
    yo = r.datos.usuario; modoServidor = true;
    return { usuario: usuarioFusionado(yo) };
  }
  async function reenviarVerificacion(email) { const r = await MSDApi.post('/api/auth/reenviar-verificacion', { email }); return r.ok ? { ok: true } : { error: r.error }; }
  async function recuperar(email) { const r = await MSDApi.post('/api/auth/recuperar', { email }); return r.ok ? { ok: true } : { error: r.error }; }
  async function restablecer(token, clave) {
    const r = await MSDApi.post('/api/auth/restablecer', { token, clave });
    if (!r.ok) return { error: r.error, codigo: r.codigo, campo: r.campo };
    yo = r.datos.usuario; modoServidor = true;
    return { usuario: usuarioFusionado(yo) };
  }

  async function actualizarPerfil(usuarioId, cambios) {
    if (modoServidor) {
      const r = await MSDApi.patch('/api/auth/perfil', { nombre: cambios.nombre, telefono: cambios.telefono || '' });
      if (!r.ok) return { error: r.error, campo: r.campo };
      yo = r.datos.usuario;
      return true;
    }
    const u = buscarPorId(usuarioId);
    if (!u) return false;
    if (typeof cambios.nombre === 'string' && cambios.nombre.trim().length >= 3) u.nombre = cambios.nombre.trim().slice(0, 120);
    if (typeof cambios.telefono === 'string') u.telefono = cambios.telefono.trim().slice(0, 20);
    persistirUsuarios();
    return true;
  }

  async function cambiarClave(usuarioId, claveActual, claveNueva) {
    if (modoServidor) {
      const r = await MSDApi.post('/api/auth/clave', { actual: claveActual, nueva: claveNueva });
      return r.ok ? { ok: true } : { error: r.error, campo: r.campo };
    }
    const u = buscarPorId(usuarioId);
    if (!u) return { error: 'Sesión no válida.' };
    if (await hashTexto(u.sal + claveActual) !== u.hash) return { error: 'La contraseña actual no es correcta.' };
    u.sal = nuevaSal(); u.hash = await hashTexto(u.sal + claveNueva); persistirUsuarios();
    return { ok: true };
  }

  /* ==========================================================================
     Tarifas configurables desde el panel (msd_tarifas, sincronizadas)
     Se aplican mutando los objetos de datos: toda la web las pinta al momento.
     ========================================================================== */

  let precioAbono = 18;

  function aplicarTarifas() {
    const t = leer('msd_tarifas', null);
    if (!t || typeof t !== 'object') return;
    if (typeof INSTALACIONES !== 'undefined' && t.instalaciones && typeof t.instalaciones === 'object') {
      for (const inst of INSTALACIONES) {
        const ajuste = t.instalaciones[inst.id];
        if (!ajuste) continue;
        if (typeof ajuste.precio === 'number' && ajuste.precio >= 0) inst.precio = ajuste.precio;
        if (typeof ajuste.suplementoLuz === 'number' && ajuste.suplementoLuz >= 0) inst.suplementoLuz = ajuste.suplementoLuz;
      }
    }
    if (typeof CLASES !== 'undefined' && t.clases && typeof t.clases === 'object') {
      for (const clase of CLASES) {
        const precio = t.clases[clase.id];
        if (typeof precio === 'number' && precio >= 0) clase.precioMes = precio;
      }
    }
    if (typeof t.abono === 'number' && t.abono >= 0) precioAbono = t.abono;
  }

  function guardarTarifas(tarifas) {
    guardar('msd_tarifas', tarifas);
    aplicarTarifas();
    anotarAutomatizacion('finanzas',
      'Tarifas actualizadas desde el panel: los nuevos precios se aplican al momento en la web y en las próximas liquidaciones.');
  }

  /* ==========================================================================
     Gestión total de usuarios (solo desde el panel de administración)
     ========================================================================== */

  function adminActualizarUsuario(id, cambios) {
    const u = buscarPorId(id);
    if (!u) return false;
    if (typeof cambios.nombre === 'string' && cambios.nombre.trim().length >= 3) u.nombre = cambios.nombre.trim().slice(0, 120);
    if (typeof cambios.telefono === 'string') u.telefono = cambios.telefono.trim().slice(0, 20);
    if (cambios.rol === 'vecino' || cambios.rol === 'monitor' || cambios.rol === 'admin') u.rol = cambios.rol;
    persistirUsuarios();
    return true;
  }

  async function adminNuevaClave(id, clave) {
    const u = buscarPorId(id);
    if (!u || String(clave).length < 8) return false;
    u.sal = nuevaSal();
    u.hash = await hashTexto(u.sal + clave);
    persistirUsuarios();
    anotarAutomatizacion('usuarios', `Contraseña restablecida para ${u.nombre} desde el panel.`);
    return true;
  }

  function adminEliminarUsuario(id) {
    const u = buscarPorId(id);
    if (!u) return false;
    usuarios = usuarios.filter((x) => x.id !== id);
    persistirUsuarios();
    anotarAutomatizacion('usuarios', `Cuenta de ${u.nombre} (${u.email}) eliminada desde el panel.`);
    return true;
  }

  async function adminCrearUsuario({ nombre, email, telefono, clave, rol }) {
    if (buscarPorEmail(email)) return { error: 'Ya existe una cuenta con ese correo.' };
    const sal = nuevaSal();
    const u = {
      id: `u-${Math.random().toString(36).slice(2, 10)}`,
      nombre: String(nombre).trim().slice(0, 120),
      email: String(email).trim().slice(0, 120),
      telefono: String(telefono || '').trim().slice(0, 20),
      rol: (rol === 'admin' || rol === 'monitor') ? rol : 'vecino',
      sal,
      hash: await hashTexto(sal + clave),
      creado: Date.now(),
      abono: null
    };
    usuarios.push(u);
    persistirUsuarios();
    anotarAutomatizacion('usuarios', `Cuenta de ${u.nombre} creada desde el panel.`);
    return { usuario: u };
  }

  /* ---------- Abono mensual del gimnasio ---------- */

  function nuevoNfcId() {
    let id = 'NFC-';
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < 8; i++) id += abc[Math.floor(Math.random() * abc.length)];
    return id;
  }

  /* UID decimal de 10 dígitos, con la misma forma que entrega el lector físico. */
  function nuevoUid() {
    let s = '';
    for (let i = 0; i < 10; i++) s += Math.floor(Math.random() * 10);
    return s;
  }

  /* Semilla secreta (16 bytes hex) para el QR dinámico del socio. */
  function nuevaSemillaQr() {
    const bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /* Rellena UID y semilla en abonos antiguos que aún no los tenían. */
  function migrarCarnets() {
    let cambio = false;
    for (const u of usuarios) {
      if (!u.abono) continue;
      if (!u.abono.nfcUid) { u.abono.nfcUid = nuevoUid(); cambio = true; }
      if (!u.abono.qrSeed) { u.abono.qrSeed = nuevaSemillaQr(); cambio = true; }
    }
    if (cambio) persistirUsuarios();
  }

  /* Al inscribirse en una actividad se emite el carnet (QR + pulsera) si no lo tenía */
  function asegurarCarnet(usuarioId) {
    const u = buscarPorId(usuarioId);
    if (!u || u.abono) return;
    const desde = hoy();
    u.abono = {
      activo: true,
      desde,
      hasta: sumarMes(desde),
      autoRenovar: false,
      nfcId: nuevoNfcId(),
      nfcUid: nuevoUid(),
      qrSeed: nuevaSemillaQr()
    };
    persistirUsuarios();
    anotarAutomatizacion('abono',
      `Carnet de actividades emitido para ${u.nombre} (${u.abono.nfcId}) al inscribirse: el torno ya acepta su QR y su pulsera.`);
    notificar(u.id, `Ya tienes tu carnet con QR en tu perfil: te abre el torno para tus actividades.`);
  }

  function activarAbono(usuarioId, autoRenovar) {
    const u = buscarPorId(usuarioId);
    if (!u) return null;
    const desde = hoy();
    u.abono = {
      activo: true,
      desde,
      hasta: sumarMes(desde),
      autoRenovar: autoRenovar === true,
      nfcId: (u.abono && u.abono.nfcId) || nuevoNfcId(),
      nfcUid: (u.abono && u.abono.nfcUid) || nuevoUid(),
      qrSeed: (u.abono && u.abono.qrSeed) || nuevaSemillaQr()
    };
    persistirUsuarios();
    anotarAutomatizacion('abono', `Alta de abono mensual de ${u.nombre}: carnet ${u.abono.nfcId} emitido y liquidación de ${precioAbono} € generada.`);
    return u.abono;
  }

  function renovarAbono(usuarioId, manual) {
    const u = buscarPorId(usuarioId);
    if (!u || !u.abono) return null;
    const base = u.abono.hasta >= hoy() ? u.abono.hasta : hoy();
    u.abono.hasta = sumarMes(base);
    u.abono.activo = true;
    persistirUsuarios();
    anotarAutomatizacion('abono',
      `${manual ? 'Renovación' : 'Renovación automática'} del abono de ${u.nombre} hasta el ${u.abono.hasta}. Liquidación de ${precioAbono} € emitida.`);
    notificar(u.id, `Tu abono del gimnasio se ha renovado hasta el ${u.abono.hasta}.`);
    return u.abono;
  }

  function cambiarAutoRenovar(usuarioId, valor) {
    const u = buscarPorId(usuarioId);
    if (!u || !u.abono) return;
    u.abono.autoRenovar = valor === true;
    persistirUsuarios();
  }

  function bajaAbono(usuarioId) {
    const u = buscarPorId(usuarioId);
    if (!u || !u.abono) return;
    u.abono.activo = false;
    u.abono.autoRenovar = false;
    persistirUsuarios();
    anotarAutomatizacion('abono', `Baja del abono de ${u.nombre}. El torno dejará de aceptar su carnet.`);
  }

  /* Carnet legado: QR ESTÁTICO con firma sencilla. Se mantiene para
     compatibilidad y como alternativa si no hay SubtleCrypto, pero el carnet
     real usa ya el QR dinámico de abajo. */
  function cargaQr(usuario) {
    if (!usuario.abono || !usuario.abono.nfcId) return null;
    const base = `MSD|${usuario.abono.nfcId}|${usuario.abono.hasta}`;
    let firma = 0x811c9dc5;
    const secreto = base + '|prado-de-la-feria';
    for (let i = 0; i < secreto.length; i++) {
      firma = Math.imul(firma ^ secreto.charCodeAt(i), 0x01000193) >>> 0;
    }
    return `${base}|${firma.toString(36).toUpperCase()}`;
  }

  /* Carnet real: QR DINÁMICO (rotatorio cada 30 s, firmado con la semilla del
     socio). Devuelve el contenido del QR y cuándo caduca, para la cuenta atrás. */
  async function cargaQrDinamica(usuario) {
    if (modoServidor) {
      // El servidor calcula los códigos; aquí solo se elige el de la ventana en curso.
      if (!usuario || !usuario.abono || !usuario.abono.vigente) return null;
      if (!loteQr) await pedirLoteQr().catch(() => {});
      if (!loteQr) return null;
      const T = ventanaActualServidor();
      const i = T - loteQr.desdeT;
      if (i < 0 || i >= loteQr.codigos.length) {               // lote agotado/adelantado
        const nuevo = await pedirLoteQr().catch(() => null);
        if (!nuevo) return { payload: null, expiraEnMs: 0, agotado: true, nfcUltimos4: usuario.abono.nfcUltimos4 };
        return cargaQrDinamica(usuario);
      }
      if (loteQr.codigos.length - i <= 3 && navigator.onLine) pedirLoteQr().catch(() => {});   // repedir con antelación
      const finVentanaMs = (T + 1) * loteQr.ventana * 1000 - (loteQr.servidorMs - loteQr.pedidoEnLocal);
      return { payload: `${loteQr.qrUid}${loteQr.codigos[i]}`, T, expiraEnMs: finVentanaMs - Date.now(), ventana: loteQr.ventana };
    }
    if (!usuario || !usuario.abono || !usuario.abono.nfcUid || !usuario.abono.qrSeed) return null;
    if (typeof MSDToken === 'undefined') return null;
    return MSDToken.generar(usuario.abono.nfcUid, usuario.abono.qrSeed);
  }

  /* ---------- Torno de acceso ---------- */

  const EDAD_MINIMA = 16;   // años; hay cartel físico en el complejo
  const AFORO_MAX = 40;     // capacidad de la sala fitness

  /* Valida un identificador (UID de tarjeta/pulsera o nfcId legado) en un
     sentido (entrada/salida) y registra el acceso.
       - Entrada: exige abono activo, en vigor y edad mínima.
       - Salida:  a cualquier carnet reconocido (siempre se puede salir). */
  function validarAcceso(ident, metodo, direccion) {
    const u = buscarPorIdentificador(ident);
    const dir = direccion === 'salida' ? 'salida' : 'entrada';
    const edad = u ? edadEn(u.birthdate) : null;
    let resultado, motivo;
    if (!u) {
      resultado = 'denegado';
      motivo = 'Carnet no reconocido';
    } else if (dir === 'salida') {
      resultado = 'ok';
      motivo = 'Salida registrada';
    } else if (!u.abono.activo) {
      resultado = 'denegado';
      motivo = 'Abono dado de baja';
    } else if (u.abono.hasta < hoy()) {
      resultado = 'denegado';
      motivo = `Abono caducado el ${u.abono.hasta}`;
    } else if (edad !== null && edad < EDAD_MINIMA) {
      resultado = 'denegado';
      motivo = `Acceso a partir de ${EDAD_MINIMA} años`;
    } else {
      resultado = 'ok';
      motivo = 'Abono en vigor';
    }
    accesos.unshift({ ts: Date.now(), usuarioId: u ? u.id : null, metodo, resultado, motivo, direccion: dir, raw: String(ident).slice(0, 64) });
    accesos = accesos.slice(0, 300);
    guardar(CLAVES.accesos, accesos);
    return { usuario: u || null, resultado, motivo, direccion: dir };
  }

  function anotarAcceso(usuarioId, metodo, resultado, motivo, direccion, raw) {
    accesos.unshift({
      ts: Date.now(), usuarioId, metodo, resultado, motivo,
      direccion: direccion === 'salida' ? 'salida' : 'entrada',
      raw: raw ? String(raw).slice(0, 64) : ''
    });
    accesos = accesos.slice(0, 300);
    guardar(CLAVES.accesos, accesos);
  }

  /* Valida un QR. Acepta el token DINÁMICO nuevo (MSD2|…) y el estático legado
     (MSD|…). Es asíncrono porque el token dinámico verifica un HMAC. */
  /* Valida CUALQUIER lectura del torno (tarjeta/pulsera o QR), venga de la cámara
     o del lector físico. Estrategia "match-first":
       1) Si coincide con un UID de tarjeta conocido → acceso por NFC.
       2) Si no, y es un token dinámico numérico válido → acceso por QR.
       3) Si es numérico pero desconocido → tarjeta no reconocida.
       4) Cualquier otra cosa → QR ilegible/ajeno.
     Es asíncrona porque el token dinámico verifica un HMAC. */
  async function validarAccesoQr(carga, direccion) {
    const v = String(carga).trim();
    const dir = direccion === 'salida' ? 'salida' : 'entrada';
    if (!v) {
      anotarAcceso(null, 'qr', 'denegado', 'Lectura vacía', dir, v);
      return { usuario: null, resultado: 'denegado', motivo: 'Lectura vacía', direccion: dir };
    }
    // 1) Tarjeta/pulsera física conocida (su UID va tal cual).
    if (buscarPorIdentificador(v)) return validarAcceso(v, 'nfc', dir);
    // 2) Token dinámico numérico (QR rotatorio del carnet).
    if (typeof MSDToken !== 'undefined' && MSDToken.esDinamico(v)) {
      const r = await MSDToken.validar(v, (uid) => {
        const u = buscarPorNfcUid(uid);
        return u && u.abono ? u.abono.qrSeed : null;
      });
      if (r.ok) return validarAcceso(r.nfcUid, 'qr', dir);
      const u = r.nfcUid ? buscarPorNfcUid(r.nfcUid) : null;
      anotarAcceso(u ? u.id : null, 'qr', 'denegado', r.motivo, dir, v);
      return { usuario: u || null, resultado: 'denegado', motivo: r.motivo, direccion: dir };
    }
    // 3) Numérico pero no reconocido → se trata como tarjeta desconocida.
    if (/^\d+$/.test(v)) return validarAcceso(v, 'nfc', dir);
    // 4) Texto ilegible o QR ajeno.
    anotarAcceso(null, 'qr', 'denegado', 'QR no reconocido', dir, v);
    return { usuario: null, resultado: 'denegado', motivo: 'QR no reconocido', direccion: dir };
  }

  /* Aforo del día a partir de los accesos reales: entradas − salidas. */
  function aforoHoy() {
    const dia = hoy();
    let entradas = 0, salidas = 0;
    for (const a of accesos) {
      if (a.resultado !== 'ok') continue;
      if (claveDia(new Date(a.ts)) !== dia) continue;
      if (a.direccion === 'salida') salidas++; else entradas++;
    }
    return { entradas, salidas, dentro: Math.max(0, entradas - salidas), aforoMax: AFORO_MAX };
  }

  /* Asigna/actualiza UID de tarjeta y fecha de nacimiento desde el panel. */
  function adminAsignarCarnet(id, cambios) {
    const u = buscarPorId(id);
    if (!u || !u.abono) return { error: 'Este vecino no tiene carnet/abono en vigor.' };
    if (typeof cambios.nfcUid === 'string' && cambios.nfcUid.trim()) {
      const uid = cambios.nfcUid.trim();
      if (!/^\d{6,20}$/.test(uid)) return { error: 'El UID debe ser un número de 6 a 20 dígitos.' };
      const otro = buscarPorNfcUid(uid);
      if (otro && otro.id !== id) return { error: `Ese UID ya está asignado a ${otro.nombre}.` };
      u.abono.nfcUid = uid;
    }
    if (typeof cambios.birthdate === 'string' && cambios.birthdate.trim()) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cambios.birthdate.trim())) return { error: 'Fecha de nacimiento no válida.' };
      u.birthdate = cambios.birthdate.trim();
    }
    if (!u.abono.qrSeed) u.abono.qrSeed = nuevaSemillaQr();
    persistirUsuarios();
    anotarAutomatizacion('acceso',
      `Carnet de ${u.nombre} actualizado desde el panel: UID ${u.abono.nfcUid}${u.birthdate ? ', nacimiento ' + u.birthdate : ''}.`);
    return { ok: true, abono: u.abono };
  }

  /* ---------- Automatización periódica ----------
     Se ejecuta en cada carga: renueva o caduca abonos según su configuración. */
  function ejecutarAutomatizaciones() {
    const dia = hoy();
    let cambios = false;
    for (const u of usuarios) {
      if (!u.abono || !u.abono.activo) continue;
      if (u.abono.hasta < dia) {
        if (u.abono.autoRenovar) {
          renovarAbono(u.id, false);
        } else {
          u.abono.activo = false;
          anotarAutomatizacion('abono',
            `El abono de ${u.nombre} caducó el ${u.abono.hasta} sin renovación automática: acceso desactivado y aviso enviado a ${u.email}.`);
          notificar(u.id, `Tu abono del gimnasio caducó el ${u.abono.hasta}. Puedes reactivarlo desde tu perfil.`);
          cambios = true;
        }
      }
    }
    if (cambios) persistirUsuarios();
  }

  /* Vuelve a leer los almacenes (sincronización entre pestañas) */
  function recargar() {
    usuarios = saneaUsuarios(leer(CLAVES.usuarios, []));
    accesos = saneaAccesos(leer(CLAVES.accesos, []));
    automatizaciones = saneaAutomatizaciones(leer(CLAVES.automatizaciones, []));
    notificaciones = saneaNotificaciones(leer(CLAVES.notificaciones, []));
    aplicarTarifas();
  }

  /* ---------- API pública ---------- */

  return {
    get PRECIO_ABONO() { return precioAbono; },
    aplicarTarifas,
    guardarTarifas,
    adminActualizarUsuario,
    adminNuevaClave,
    adminEliminarUsuario,
    adminCrearUsuario,
    recargar,
    listo: (async () => {
      // 1) Sesión de servidor (F2): ¿quién soy según la cookie?
      const conApi = await cargarYo().catch(() => false);
      // 2) Estado legado compartido (abonos, accesos, tarifas…) hasta F3–F6.
      if (typeof MSDSync !== 'undefined') {
        const conServidor = await MSDSync.arrancar();
        if (conServidor) recargar();
      }
      // 3) Solo en modo LOCAL (sin API de cuentas) se siembra la demo antigua.
      if (!conApi) {
        await sembrar();
        const lucia = buscarPorEmail('lucia@correo.es');
        if (lucia && lucia.rol === 'vecino') { lucia.rol = 'monitor'; persistirUsuarios(); }
      }
      migrarCarnets(); // rellena UID/semilla en abonos anteriores al torno real
      aplicarTarifas();
      ejecutarAutomatizaciones();
    })(),
    get modoServidor() { return modoServidor; },
    recargarYo,
    verificarCorreo,
    reenviarVerificacion,
    recuperar,
    restablecer,
    usuarios: () => usuarios.slice(),
    accesos: () => accesos.slice(),
    automatizaciones: () => automatizaciones.slice(),
    anotarAutomatizacion,
    notificar,
    notificacionesDe,
    marcarLeidas,
    sesionActual,
    registrar,
    entrar,
    salir,
    actualizarPerfil,
    cambiarClave,
    buscarPorId,
    buscarPorNfc,
    buscarPorNfcUid,
    buscarPorIdentificador,
    edadEn,
    EDAD_MINIMA,
    AFORO_MAX,
    asegurarCarnet,
    activarAbono,
    renovarAbono,
    cambiarAutoRenovar,
    bajaAbono,
    cargaQr,
    cargaQrDinamica,
    validarAcceso,
    validarAccesoQr,
    anotarAcceso,
    aforoHoy,
    adminAsignarCarnet,
    hoy
  };
})();
