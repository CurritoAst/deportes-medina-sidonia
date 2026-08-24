/* ==========================================================================
   Deportes · Medina Sidonia — panel de administración
   Requiere sesión con rol 'admin'. Lee y escribe los mismos almacenes que
   la web pública (reservas, inscripciones, ajustes de clases, accesos).
   ========================================================================== */

(function () {
  'use strict';

  const $ = (sel, raiz) => (raiz || document).querySelector(sel);
  const $$ = (sel, raiz) => Array.from((raiz || document).querySelectorAll(sel));

  const esc = (t) => String(t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const eur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
  const icono = (id, tam) =>
    `<svg width="${tam || 18}" height="${tam || 18}" aria-hidden="true"><use href="#${id}"/></svg>`;

  const fmtDia = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtMomento = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const pad2 = (n) => String(n).padStart(2, '0');
  const minutosALabel = (min) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
  const legibleClave = (clave) => {
    const [a, m, d] = String(clave).split('-').map(Number);
    return fmtDia.format(new Date(a, m - 1, d));
  };
  /* Fechas de abono legibles: «21 sep» en vez de «2026-09-21»; días que faltan */
  const RE_FECHA_CORTA = /^\d{4}-\d{2}-\d{2}$/;
  const diaApi = (s) => (s ? String(s).slice(0, 10) : '');
  const fmtDiaCorto = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' });
  const diaLegible = (s) => { const d = diaApi(s); if (!RE_FECHA_CORTA.test(d)) return d; return fmtDiaCorto.format(new Date(d + 'T00:00')); };
  const diasHasta = (s) => { const d = diaApi(s); if (!RE_FECHA_CORTA.test(d)) return Infinity; return Math.ceil((new Date(d + 'T00:00') - Date.now()) / 864e5); };

  /* ---------- Almacenes compartidos con la web pública ---------- */

  const leer = (clave, porDefecto) => {
    try {
      const bruto = localStorage.getItem(clave);
      const v = bruto ? JSON.parse(bruto) : porDefecto;
      return v === null || v === undefined ? porDefecto : v;
    } catch (e) { return porDefecto; }
  };
  const guardar = (clave, valor) => {
    try { localStorage.setItem(clave, JSON.stringify(valor)); } catch (e) { /* demo */ }
    if (typeof MSDSync !== 'undefined') MSDSync.empujar(clave);
  };

  const clasePorId = (id) => CLASES.find((c) => c.id === id);
  const instPorId = (id) => INSTALACIONES.find((i) => i.id === id);

  const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
  const cargarReservas = () => {
    const lista = leer('msd_reservas', []);
    if (!Array.isArray(lista)) return [];
    // Mismo esquema que sanea la web pública: una fila corrupta no debe
    // tumbar la tabla entera del panel
    return lista.filter((r) => r && typeof r === 'object'
      && !!instPorId(r.instId)
      && typeof r.id === 'string'
      && typeof r.localizador === 'string'
      && RE_FECHA.test(String(r.fecha))
      && Number.isInteger(r.hora) && r.hora >= 0 && r.hora < 1440);
  };
  const cargarInscripciones = () => {
    const lista = leer('msd_inscripciones', []);
    return Array.isArray(lista) ? lista.filter((i) => i && clasePorId(i.claseId) && typeof i.usuarioId === 'string') : [];
  };
  const cargarAjustes = () => {
    const a = leer('msd_clases_ajustes', {});
    return (a && typeof a === 'object' && !Array.isArray(a)) ? a : {};
  };

  const baseInscritos = (clase) => {
    const a = cargarAjustes()[clase.id];
    return a && Number.isInteger(a.inscritosBase) ? Math.min(Math.max(a.inscritosBase, 0), clase.aforo) : clase.inscritosBase;
  };
  const baseCola = (clase) => {
    const a = cargarAjustes()[clase.id];
    return a && Number.isInteger(a.colaBase) ? Math.max(a.colaBase, 0) : clase.colaBase;
  };

  function estadoClase(clase) {
    const deClase = cargarInscripciones().filter((i) => i.claseId === clase.id);
    const inscritosReales = deClase.filter((i) => i.estado === 'inscrito');
    const esperasReales = deClase.filter((i) => i.estado === 'espera').sort((a, b) => a.desde - b.desde);
    const inscritos = baseInscritos(clase) + inscritosReales.length;
    return {
      inscritosReales,
      esperasReales,
      inscritos,
      libres: Math.max(0, clase.aforo - inscritos),
      cola: baseCola(clase) + esperasReales.length
    };
  }

  /* La misma regla de automatización que la web pública */
  function promocionarCola(clase) {
    const est = estadoClase(clase);
    if (est.libres <= 0 || est.cola === 0) return;
    if (baseCola(clase) > 0) {
      const ajustes = cargarAjustes();
      ajustes[clase.id] = { inscritosBase: baseInscritos(clase) + 1, colaBase: baseCola(clase) - 1 };
      guardar('msd_clases_ajustes', ajustes);
      MSDAuth.anotarAutomatizacion('clases',
        `Plaza libre en ${clase.nombre}: la siguiente persona de la lista de espera ha sido inscrita y avisada automáticamente.`);
      return;
    }
    const inscripciones = cargarInscripciones();
    const siguiente = inscripciones
      .filter((i) => i.claseId === clase.id && i.estado === 'espera')
      .sort((a, b) => a.desde - b.desde)[0];
    if (!siguiente) return;
    siguiente.estado = 'inscrito';
    guardar('msd_inscripciones', inscripciones);
    MSDAuth.asegurarCarnet(siguiente.usuarioId);
    const quien = MSDAuth.buscarPorId(siguiente.usuarioId);
    MSDAuth.anotarAutomatizacion('clases',
      `Plaza libre en ${clase.nombre}: ${quien ? quien.nombre : 'una persona en espera'} pasa de la cola a inscrita (aviso enviado automáticamente).`);
  }

  /* ---------- Avisos y diálogo ---------- */

  const contAvisos = $('#avisos');
  function avisar(mensaje, tipo) {
    const aviso = document.createElement('div');
    const esError = tipo === 'error';
    aviso.className = `aviso${esError ? ' aviso--error' : ' aviso--ok'}`;
    if (esError) aviso.setAttribute('role', 'alert');
    // Los errores duran más y se pueden cerrar a mano (recepción necesita tiempo para leerlos)
    aviso.innerHTML = `${icono(esError ? 'i-info' : 'i-check', 18)}<span>${esc(mensaje)}</span>${esError ? '<button class="aviso__cerrar" type="button" aria-label="Cerrar aviso">×</button>' : ''}`;
    contAvisos.appendChild(aviso);
    const quitar = () => aviso.remove();
    const cerrar = aviso.querySelector('.aviso__cerrar');
    if (cerrar) cerrar.addEventListener('click', quitar);
    setTimeout(quitar, esError ? 10000 : 4200);
  }

  /* Evita el doble toque: deshabilita el botón mientras dura la acción */
  async function conBloqueo(boton, fn) {
    if (!boton || boton.disabled) return;
    boton.disabled = true;
    boton.setAttribute('aria-busy', 'true');
    try { await fn(); } finally {
      if (boton.isConnected) { boton.disabled = false; boton.removeAttribute('aria-busy'); }
    }
  }

  const dlgFondo = $('#dialogo-fondo');
  let dlgResolver = null;
  let dlgAbiertoEn = 0;
  let dlgDisparador = null;
  function confirmar(titulo, texto, textoAceptar) {
    return new Promise((resolver) => {
      dlgResolver = resolver;
      dlgAbiertoEn = performance.now();
      dlgDisparador = document.activeElement;
      $('#dialogo-titulo').textContent = titulo;
      $('#dialogo-texto').textContent = texto;
      $('#dialogo-aceptar').textContent = textoAceptar || 'Sí, continuar';
      dlgFondo.hidden = false;
      const main = $('#contenido-admin'); if (main) main.inert = true;   // el resto de la página no recibe foco
      $('#dialogo-cancelar').focus();
    });
  }
  function cerrarDialogo(res) {
    if (!dlgResolver) return;
    dlgFondo.hidden = true;
    const main = $('#contenido-admin'); if (main) main.inert = false;
    const r = dlgResolver;
    dlgResolver = null;
    r(res);
    // el foco vuelve al botón que abrió el diálogo (tras re-habilitarse, si estaba bloqueado)
    const disp = dlgDisparador; dlgDisparador = null;
    setTimeout(() => { if (disp && disp.isConnected && !disp.disabled) disp.focus(); else { const t = $('#titulo-admin'); if (t) { t.setAttribute('tabindex', '-1'); t.focus(); } } }, 0);
  }
  $('#dialogo-cancelar').addEventListener('click', () => cerrarDialogo(false));
  $('#dialogo-aceptar').addEventListener('click', () => cerrarDialogo(true));
  dlgFondo.addEventListener('click', (ev) => {
    if (ev.target === dlgFondo && performance.now() - dlgAbiertoEn > 350) cerrarDialogo(false);
  });
  document.addEventListener('keydown', (ev) => {
    if (dlgFondo.hidden) return;
    if (ev.key === 'Escape') { ev.preventDefault(); cerrarDialogo(false); }
    if (ev.key === 'Tab') {
      ev.preventDefault();
      (document.activeElement === $('#dialogo-cancelar') ? $('#dialogo-aceptar') : $('#dialogo-cancelar')).focus();
    }
  });

  /* Mostrar/ocultar contraseña */
  document.addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-ver-clave]');
    if (!boton) return;
    const campo = $(`#${boton.dataset.verClave}`);
    if (!campo) return;
    const visible = campo.type === 'text';
    campo.type = visible ? 'password' : 'text';
    boton.setAttribute('aria-pressed', String(!visible));
    boton.textContent = visible ? 'Ver' : 'Ocultar'; // el texto visible es el nombre accesible
  });

  /* Cambios desde otra pestaña (la web pública): recarga y repinta */
  window.addEventListener('storage', (ev) => {
    if (!ev.key || !ev.key.startsWith('msd_')) return;
    MSDAuth.recargar();
    if (!$('#admin-app').hidden) irASeccion(seccionActual);
  });

  /* ==========================================================================
     Secciones
     ========================================================================== */

  const vecinos = () => MSDAuth.usuarios().filter((u) => u.rol === 'vecino');
  const abonoVigente = (u) => u.abono && u.abono.activo && u.abono.hasta >= MSDAuth.hoy();
  /* Nombres de socios de la API (modo servidor) para el gimnasio, que sigue en
     almacén local hasta F5: cada lista o ficha cargada los anota. */
  const nombresApi = (() => { try { const v = JSON.parse(localStorage.getItem('msd_nombres_api') || '{}'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } })();
  function anotarNombresApi(lista) {
    let cambio = false;
    for (const u of lista || []) { if (u && u.id && u.nombre && nombresApi[u.id] !== u.nombre) { nombresApi[u.id] = u.nombre; cambio = true; } }
    if (cambio) { try { localStorage.setItem('msd_nombres_api', JSON.stringify(nombresApi)); } catch (e) { /* sin sitio */ } }
  }
  const nombreDe = (usuarioId) => {
    const u = usuarioId && MSDAuth.buscarPorId(usuarioId);
    return u ? u.nombre : (nombresApi[usuarioId] || 'Vecino/a');
  };

  /* ---------- Panel ---------- */

  function pintarPanel() {
    const hoyClave = MSDAuth.hoy();
    const reservas = cargarReservas();
    const inscripciones = cargarInscripciones();
    const abonados = vecinos().filter(abonoVigente);
    const proximas = reservas.filter((r) => r.fecha >= hoyClave);
    const llenas = CLASES.filter((c) => estadoClase(c).libres === 0);
    const enCola = CLASES.reduce((n, c) => n + estadoClase(c).cola, 0);
    const accesosHoy = MSDAuth.accesos().filter((a) => {
      const d = new Date(a.ts);
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` === hoyClave;
    });
    const ingresos = abonados.length * MSDAuth.PRECIO_ABONO
      + inscripciones.filter((i) => i.estado === 'inscrito').reduce((n, i) => n + clasePorId(i.claseId).precioMes, 0)
      + proximas.reduce((n, r) => n + (typeof r.precio === 'number' ? r.precio : 0), 0);
    const caducan = vecinos().filter((u) => abonoVigente(u) && diasHasta(u.abono.hasta) <= 7).length;

    /* «Ahora mismo»: torno, aforo, franja de gimnasio en curso y último acceso */
    const todosAccesos = MSDAuth.accesos();
    const ultimo = todosAccesos[0];
    const dentro = accesosHoy.filter((a) => a.resultado === 'ok' && a.direccion !== 'salida').length
      - accesosHoy.filter((a) => a.resultado === 'ok' && a.direccion === 'salida').length;
    const franjaAhora = `${pad2(new Date().getHours())}:00`;
    const gimAbierto = MSDGimnasio.config().franjas.includes(franjaAhora);
    const gim = gimAbierto ? MSDGimnasio.ocupacion(franjaAhora) : null;
    const infoTorno = estadoTornoInfo(null);
    $('#admin-ahora').innerHTML = [
      `<button class="ahora__item ${infoTorno.clase}" type="button" data-ir="torno" id="ahora-torno"><small>Torno</small><strong>${MSDAuth.modoServidor ? '…' : esc(infoTorno.texto)}</strong><small>${MSDAuth.modoServidor ? 'consultando' : esc(infoTorno.detalle)}</small></button>`,
      `<div class="ahora__item" id="ahora-dentro"><small>Dentro ahora</small><strong>${Math.max(0, dentro)}</strong><small>entradas − salidas de hoy</small></div>`,
      gim
        ? `<button class="ahora__item${gim.asignados >= gim.capacidad ? ' ahora__item--aviso' : ''}" type="button" data-ir="gimnasio"><small>Gimnasio · ${esc(MSDGimnasio.etiqueta(franjaAhora))}</small><strong>${gim.asignados} / ${gim.capacidad}</strong><small>${gim.espera ? gim.espera + ' en lista de espera' : 'sin lista de espera'}</small></button>`
        : '<button class="ahora__item" type="button" data-ir="gimnasio"><small>Gimnasio</small><strong>Sin franja</strong><small>fuera del horario por horas</small></button>',
      `<button class="ahora__item${ultimo ? (ultimo.resultado === 'ok' ? ' ahora__item--ok' : ' ahora__item--mal') : ''}" type="button" data-ir="torno" id="ahora-ultimo"><small>Último acceso</small><strong>${ultimo ? esc(ultimo.usuarioId ? nombreDe(ultimo.usuarioId) : (ultimo.raw || 'Desconocido')) : '—'}</strong><small>${ultimo ? esc(fmtMomento.format(new Date(ultimo.ts))) + ' · ' + (ultimo.resultado === 'ok' ? 'permitido' : esc(ultimo.motivo || 'denegado')) : 'sin accesos todavía'}</small></button>`
    ].join('');

    /* Cifras: botones que llevan a su sección; dorado = algo que atender */
    const kpi = (id, v, t, clase, ir) => `<button class="kpi${clase ? ' ' + clase : ''}" type="button" id="${id}"${ir ? ` data-ir="${ir}"` : ''}><strong>${esc(String(v))}</strong><span>${esc(t)}</span></button>`;
    $('#admin-kpis').innerHTML = [
      kpi('kpi-abonados', abonados.length, 'Abonados en vigor', '', 'abonados'),
      kpi('kpi-caducan', caducan, 'Abonos que caducan en 7 días', caducan ? 'kpi--aviso' : '', 'abonados'),
      kpi('kpi-cola', enCola, 'Personas en cola', enCola ? 'kpi--aviso' : '', 'clases'),
      kpi('kpi-llenas', `${llenas.length} / ${CLASES.length}`, 'Clases completas', llenas.length ? 'kpi--aviso' : '', 'clases'),
      kpi('kpi-reservas', proximas.length, 'Reservas próximas', '', 'reservas'),
      kpi('kpi-accesos', accesosHoy.length, 'Accesos hoy por el torno', '', 'torno'),
      MSDAuth.modoServidor ? `<button class="kpi" type="button" id="kpi-impagos" data-foco="admin-impagos"><strong>…</strong><span>Recibos devueltos</span></button>` : '',
      kpi('kpi-ingresos', eur.format(ingresos), 'Ingresos estimados del mes', 'kpi--secundario', 'tarifas')
    ].join('');

    $('#admin-auto-resumen').innerHTML = htmlAutomatizaciones(5);
    if (MSDAuth.modoServidor) refrescarInicioServidor();
  }

  /* Con BD: el torno real, el aforo y los abonos vienen de la API (el resto sigue local hasta F4–F6) */
  async function refrescarInicioServidor() {
    const [est, af, us, acc, imp] = await Promise.all([
      MSDApi.get('/api/admin/torno/estado'), MSDApi.get('/api/aforo'), MSDApi.get('/api/admin/usuarios'), MSDApi.get('/api/admin/accesos'), MSDApi.get('/api/admin/impagos')
    ]);
    if (seccionActual !== 'panel') return;
    if (est.ok) pintarEstadoTorno(est.datos);
    if (imp.ok) pintarImpagos(imp.datos);
    const d = $('#ahora-dentro');
    if (d && af.ok) d.innerHTML = `<small>Dentro ahora</small><strong>${Number(af.datos.dentro) || 0}${af.datos.aforoMax ? ' / ' + af.datos.aforoMax : ''}</strong><small>entradas − salidas de hoy</small>`;
    if (us.ok) {
      const lista = us.datos.usuarios || [];
      anotarNombresApi(lista);
      const vig = lista.filter((u) => u.abono && u.abono.vigente);
      const cad = vig.filter((u) => diasHasta(u.abono.hasta) <= 7).length;
      const k1 = $('#kpi-abonados'); if (k1) k1.querySelector('strong').textContent = String(vig.length);
      const k2 = $('#kpi-caducan'); if (k2) { k2.querySelector('strong').textContent = String(cad); k2.classList.toggle('kpi--aviso', cad > 0); }
    }
    if (acc.ok) {
      const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
      const deHoy = (acc.datos.accesos || []).filter((a) => a.ts >= hoy.getTime());
      const k = $('#kpi-accesos'); if (k) k.querySelector('strong').textContent = String(deHoy.length);
      const u = (acc.datos.accesos || [])[0];
      const el = $('#ahora-ultimo');
      if (el && u) {
        el.className = 'ahora__item ' + (u.resultado === 'ok' ? 'ahora__item--ok' : 'ahora__item--mal');
        el.innerHTML = `<small>Último acceso</small><strong>${esc(u.nombre || u.raw || 'Desconocido')}</strong><small>${esc(fmtMomento.format(new Date(u.ts)))} · ${u.resultado === 'ok' ? 'permitido' : esc(u.motivo || 'denegado')}</small>`;
      }
    }
  }

  /* Estado del torno real, compartido por Inicio, la sección Torno y el chip de la cabecera */
  function estadoTornoInfo(e) {
    if (!e) return { clase: '', insignia: 'insignia--neutra', texto: 'Simulado', detalle: 'modo demo, sin torno real' };
    if (!e.tokenConfigurado) return { clase: 'ahora__item--aviso', insignia: 'insignia--aviso', texto: 'Sin configurar', detalle: 'falta MSD_TOKEN_TORNO en el servidor y en la Pi' };
    if (e.enLinea) return { clase: 'ahora__item--ok', insignia: 'insignia--plazas', texto: 'En línea', detalle: `${e.nombre || 'torno'} · hace ${Math.max(0, Math.round((Date.now() - e.ultimoContacto) / 1000))} s${e.version ? ' · v' + e.version : ''}` };
    return { clase: 'ahora__item--mal', insignia: 'insignia--llena', texto: 'Sin contacto', detalle: e.ultimoContacto ? 'último hace ' + Math.round((Date.now() - e.ultimoContacto) / 60000) + ' min' : 'todavía no se ha conectado' };
  }
  function pintarEstadoTorno(e) {
    const i = estadoTornoInfo(e);
    const html = `<span class="insignia ${i.insignia}">Torno ${i.texto.toLowerCase()}</span> <small>${esc(i.detalle)}</small>`;
    const sec = $('#torno-api-estado'); if (sec) sec.innerHTML = html;
    const chipI = $('#chip-torno-insignia'); const chipT = $('#chip-torno-texto');
    if (chipI) { chipI.className = `insignia ${i.insignia}`; chipI.textContent = 'Torno'; }
    if (chipT) { chipT.textContent = i.texto.toLowerCase(); chipT.title = i.detalle; }
    const ahora = $('#ahora-torno');
    if (ahora) { ahora.className = `ahora__item ${i.clase}`; ahora.innerHTML = `<small>Torno</small><strong>${esc(i.texto)}</strong><small>${esc(i.detalle)}</small>`; }
  }

  /* ---------- Reservas ---------- */

  let filtroReservasInst = 'todas';
  let soloProximas = true;

  function pintarReservas() {
    const hoyClave = MSDAuth.hoy();
    const reservas = cargarReservas()
      .filter((r) => filtroReservasInst === 'todas' || r.instId === filtroReservasInst)
      .filter((r) => !soloProximas || r.fecha >= hoyClave)
      .sort((a, b) => a.fecha === b.fecha ? a.hora - b.hora : (a.fecha < b.fecha ? -1 : 1));
    const cont = $('#admin-reservas');

    const controles = `
      <div class="admin-filtros">
        <label class="admin-filtros__campo">
          <span>Instalación</span>
          <select id="filtro-reservas-inst">
            <option value="todas"${filtroReservasInst === 'todas' ? ' selected' : ''}>Todas</option>
            ${INSTALACIONES.map((i) =>
              `<option value="${i.id}"${filtroReservasInst === i.id ? ' selected' : ''}>${esc(i.nombre)}</option>`).join('')}
          </select>
        </label>
        <label class="admin-filtros__check">
          <input type="checkbox" id="filtro-reservas-proximas"${soloProximas ? ' checked' : ''}>
          Solo próximas
        </label>
      </div>`;

    if (!reservas.length) {
      cont.innerHTML = controles + '<div class="aviso-vacio"><strong>No hay reservas con esos filtros</strong>Prueba a cambiar la instalación o incluir las pasadas.</div>';
      return;
    }
    cont.innerHTML = controles + `
      <div class="tabla-envoltura" tabindex="0" role="region" aria-label="Tabla desplazable">
      <table class="tabla">
        <thead><tr>
          <th scope="col">Localizador</th><th scope="col">Vecino/a</th><th scope="col">Instalación</th>
          <th scope="col">Día</th><th scope="col">Hora</th><th scope="col">Importe</th><th scope="col"><span class="visualmente-oculto">Acciones</span></th>
        </tr></thead>
        <tbody>
          ${reservas.map((r) => {
            const inst = instPorId(r.instId);
            const pista = inst.pistas.find((p) => p.id === r.pistaId);
            return `<tr>
              <td data-etiqueta="Localizador"><span class="tarjeta-reserva__loc">${esc(r.localizador)}</span></td>
              <td data-etiqueta="Vecino/a">${esc(r.usuarioId ? nombreDe(r.usuarioId) : (r.nombre || 'Vecino/a'))}</td>
              <td data-etiqueta="Instalación">${esc(inst.nombre)}${pista ? ' · ' + esc(pista.nombre) : ''}</td>
              <td data-etiqueta="Día">${esc(legibleClave(r.fecha))}</td>
              <td data-etiqueta="Hora">${minutosALabel(r.hora)}</td>
              <td data-etiqueta="Importe">${eur.format(r.precio || 0)}</td>
              <td data-etiqueta="Acciones"><button class="boton--texto" type="button" data-cancelar="${esc(r.id)}">Cancelar</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      </div>`;
  }

  /* ---------- Clases ---------- */

  function pintarClases() {
    const cont = $('#admin-clases');
    cont.innerHTML = CLASES.map((clase) => {
      const est = estadoClase(clase);
      const insignia = est.libres === 0
        ? '<span class="insignia insignia--llena">Completa</span>'
        : `<span class="insignia insignia--plazas">${est.libres} libres</span>`;
      const colaTxt = est.cola > 0
        ? `<span class="insignia insignia--pocas">${icono('i-cola', 14)} ${est.cola} en cola</span>` : '';

      const gente = [
        `<span class="persona-chip">${icono('i-personas', 14)} ${baseInscritos(clase)} vecinos (histórico)</span>`,
        ...est.inscritosReales.map((i) =>
          `<span class="persona-chip">${esc(nombreDe(i.usuarioId))}
            <button class="boton--texto" type="button" data-baja-clase="${esc(clase.id)}" data-usuario="${esc(i.usuarioId)}" aria-label="Dar de baja a ${esc(nombreDe(i.usuarioId))} de ${esc(clase.nombre)}">${icono('i-x', 13)}</button>
          </span>`),
        ...(baseCola(clase) > 0 ? [`<span class="persona-chip persona-chip--espera">${icono('i-cola', 14)} ${baseCola(clase)} esperando (histórico)</span>`] : []),
        ...est.esperasReales.map((i, idx) =>
          `<span class="persona-chip persona-chip--espera">${idx + 1 + baseCola(clase)}º · ${esc(nombreDe(i.usuarioId))}</span>`)
      ].join('');

      return `
        <article class="admin-clase">
          <div class="admin-clase__cima">
            <div>
              <h3>${esc(clase.nombre)}</h3>
              <span class="paso__ayuda" style="margin:0">${esc(clase.dias)} · ${esc(clase.hora)} · ${esc(clase.monitor)}</span>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">${insignia}${colaTxt}</div>
          </div>
          <div class="aforo">
            <div class="aforo__texto"><span>Ocupación</span><span>${est.inscritos} / ${clase.aforo}</span></div>
            <div class="aforo__barra"><div class="aforo__relleno${est.libres === 0 ? ' aforo__relleno--llena' : ''}" style="width:${Math.min(100, Math.round((est.inscritos / clase.aforo) * 100))}%"></div></div>
          </div>
          <div class="admin-clase__gente">${gente}</div>
          <div class="admin-clase__acciones">
            ${baseInscritos(clase) > 0 ? `<button class="boton boton--secundario" type="button" data-simular-baja="${esc(clase.id)}">Simular una baja</button>` : ''}
          </div>
        </article>`;
    }).join('');
  }

  /* ---------- Abonados ---------- */

  let busquedaAbonados = '';
  let filtroAbonoApi = '';          // ''|vigente|caducado|sin (el mismo select sirve en local y en servidor)

  /* Insignia de estado del abono: verde en vigor, dorado si caduca en ≤7 días,
     rojo caducado/baja, gris sin abono. `a` lleva .vigente ya calculado. */
  function estadoInsignia(a) {
    if (!a || (!a.hasta && !a.qrUid && !a.activo)) return '<span class="insignia insignia--neutra">Sin abono</span>';
    const hasta = diaApi(a.hasta);
    if (a.vigente) {
      const d = diasHasta(hasta);
      return d <= 7 ? `<span class="insignia insignia--aviso" title="${esc(hasta)}">Caduca en ${d} d</span>`
        : `<span class="insignia insignia--plazas" title="${esc(hasta)}">Hasta ${esc(diaLegible(hasta))}</span>`;
    }
    if (a.activo) return `<span class="insignia insignia--llena" title="${esc(hasta)}">Caducado ${esc(diaLegible(hasta))}</span>`;
    return '<span class="insignia insignia--llena">De baja</span>';
  }

  /* Tabla de socios, común a los dos modos: Socio/a · Abono · Pulsera · Acciones.
     La fila entera abre la ficha; «Abrir ficha» es la única acción visible con borde. */
  function tablaSocios(lista, local) {
    const A = local
      ? { fila: 'data-fila', abrir: 'data-gestionar', renovar: 'data-renovar', alta: 'data-activar' }
      : { fila: 'data-api-fila', abrir: 'data-api-gestionar', renovar: 'data-api-renovar', alta: 'data-api-gestionar' };
    return `
      <div class="tabla-envoltura tabla-envoltura--alta" tabindex="0" role="region" aria-label="Lista de socios">
      <table class="tabla tabla--socios">
        <thead><tr>
          <th scope="col">Socio/a</th><th scope="col">Abono</th><th scope="col">Pulsera</th><th scope="col"><span class="visualmente-oculto">Acciones</span></th>
        </tr></thead>
        <tbody>${lista.map((u) => {
          const a = u.abono; const id = esc(String(u.id));
          return `<tr class="tabla__fila" ${A.fila}="${id}">
            <td data-etiqueta="Socio/a"><button class="enlace-nombre" type="button" ${A.abrir}="${id}"><strong>${esc(u.nombre)}</strong></button>${u.rol && u.rol !== 'vecino' ? ` <span class="insignia insignia--neutra">${esc(u.rol)}</span>` : ''}${u.verificado === false ? ' <span class="insignia insignia--aviso">sin verificar</span>' : ''}<br><small class="tabla__sub">${esc(u.email)}${u.telefono ? ' · ' + esc(u.telefono) : ''}</small></td>
            <td data-etiqueta="Abono">${estadoInsignia(a)}${a && a.impago ? ' <span class="insignia insignia--llena">recibo devuelto</span>' : ''}${a && a.vigente && a.autoRenovar ? '<br><small class="tabla__sub">domiciliación mensual</small>' : ''}</td>
            <td data-etiqueta="Pulsera">${a && a.nfcUid ? `${icono('i-nfc', 14)} <span class="mono" title="${esc(a.nfcUid)}">···${esc(String(a.nfcUid).slice(-4))}</span>` : '<span class="tabla__sub">sin pulsera</span>'}</td>
            <td data-etiqueta="Acciones" class="tabla__acciones">
              ${a && a.vigente
                ? `<button class="boton--texto boton--compacto" type="button" ${A.renovar}="${id}">Renovar</button>`
                : `<button class="boton--texto boton--compacto" type="button" ${A.alta}="${id}"${local ? '' : ' data-foco-ficha="ea-meses"'}>${a && a.hasta ? 'Reactivar' : 'Dar de alta'}</button>`}
              <button class="boton boton--secundario boton--compacto" type="button" ${A.abrir}="${id}">Abrir ficha</button>
            </td>
          </tr>`;
        }).join('')}</tbody>
      </table>
      </div>`;
  }

  function pintarAbonados() {
    const texto = busquedaAbonados.trim().toLowerCase();
    const lista = vecinos()
      .filter((u) => !texto || u.nombre.toLowerCase().includes(texto) || u.email.toLowerCase().includes(texto) || (u.abono && String(u.abono.nfcUid || '') === busquedaAbonados.trim()))
      .filter((u) => !filtroAbonoApi || (filtroAbonoApi === 'vigente' ? abonoVigente(u) : filtroAbonoApi === 'caducado' ? (u.abono && !abonoVigente(u)) : !u.abono));
    const cont = $('#admin-abonados');
    if (!lista.length) {
      cont.innerHTML = '<div class="aviso-vacio"><strong>Sin resultados</strong>Prueba con otro nombre, correo o UID de pulsera.</div>';
      return;
    }
    cont.innerHTML = tablaSocios(lista.map((u) => ({ id: u.id, nombre: u.nombre, email: u.email, telefono: u.telefono, rol: u.rol, abono: u.abono ? { ...u.abono, vigente: abonoVigente(u) } : null })), true);
  }

  /* ---------- Ficha del socio (común a los dos modos) ----------
     Mientras está abierta sustituye a la lista: nada de «editor arriba, tabla abajo». */
  function abrirFicha() {
    $('#seccion-abonados').classList.add('seccion--ficha');
    $('#editor-usuario').hidden = false;
  }
  function cerrarFicha() {
    const ed = $('#editor-usuario');
    ed.hidden = true; ed.innerHTML = '';
    $('#seccion-abonados').classList.remove('seccion--ficha');
    const b = $('#buscar-abonado'); if (b && seccionActual === 'abonados') b.focus();
  }
  /* Repinta la ficha abierta (tras una acción) sin perder el foco */
  function refrescarFichaAbierta() {
    const f = $('#editor-usuario form'); if (!f || $('#editor-usuario').hidden) return;
    const activo = document.activeElement && document.activeElement.id;
    if (f.dataset.editorApi) abrirEditorApi(f.dataset.editorApi, { foco: activo || 'ficha-titulo' });
    else if (f.dataset.editorUsuario) abrirEditorUsuario(f.dataset.editorUsuario, { foco: activo || 'ficha-titulo' });
  }
  function htmlFichaCabecera(u, a) {
    return `
      <header class="ficha__cabecera">
        <button class="boton--texto ficha__volver" type="button" data-cerrar-editor aria-label="Volver a la lista de socios">← Lista</button>
        <div class="ficha__quien">
          <h3 class="ficha__nombre" id="ficha-titulo" tabindex="-1">${esc(u.nombre)}</h3>
          <div class="ficha__estado">${estadoInsignia(a)}${a && a.impago ? ' <span class="insignia insignia--llena">recibo devuelto</span>' : ''}${a && a.nfcUid ? ` <span class="ficha__uid">Pulsera <code>${esc(a.nfcUid)}</code></span>` : ' <span class="tabla__sub">sin pulsera</span>'}${u.verificado === false ? ' <span class="insignia insignia--aviso">correo sin verificar</span>' : ''}${u.rol && u.rol !== 'vecino' ? ` <span class="insignia insignia--neutra">${esc(u.rol)}</span>` : ''} <span class="tabla__sub">${esc(u.email)}${u.telefono ? ' · ' + esc(u.telefono) : ''}</span></div>
        </div>
        <p class="campo__error ficha__error" id="ea-error" role="alert" hidden></p>
      </header>`;
  }
  function opcionesFranjas(seleccion) {
    return MSDGimnasio.config().franjas.map((f) => {
      const o = MSDGimnasio.ocupacion(f);
      const est = o.asignados >= o.capacidad ? `LLENA${o.espera ? ' · ' + o.espera + ' en cola' : ''}` : `${o.asignados}/${o.capacidad}`;
      return `<option value="${f}"${f === seleccion ? ' selected' : ''}>${esc(MSDGimnasio.etiqueta(f))} — ${est}</option>`;
    }).join('');
  }
  /* Bloque 4 de la ficha: hora de gimnasio asignada (mover/quitar) o apuntar */
  function htmlBloqueGimnasio(id, conAbono) {
    const g = MSDGimnasio.deUsuario(String(id));
    if (g) {
      return `
        <p class="ficha__resumen">Hora de gimnasio: <strong>${esc(MSDGimnasio.etiqueta(g.franja))}</strong> ${g.estado === 'espera' ? `<span class="insignia insignia--aviso">${g.posicion}.º en lista de espera</span>` : '<span class="insignia insignia--plazas">asignado</span>'}${g.nota ? `<br><small class="tabla__sub">Nota: ${esc(g.nota)}</small>` : ''}</p>
        <div class="ficha__acciones"><span class="gim-persona__acc"><button class="boton--texto boton--compacto" type="button" data-gim-mover="${esc(g.id)}">Mover de hora</button></span><button class="boton--texto boton--compacto es-peligro" type="button" data-gim-quitar="${esc(g.id)}">Quitar del gimnasio</button></div>`;
    }
    const dis = conAbono ? '' : ' disabled';
    return `
      <p class="ficha__resumen">${conAbono ? 'Sin hora de gimnasio asignada.' : 'Para apuntarle al gimnasio primero dale de alta el abono (paso 2).'}</p>
      <div class="admin-campos">
        <label><span>Hora</span><select id="ficha-gim-franja"${dis}>${opcionesFranjas()}</select></label>
        <label><span>Nota / estado físico (opcional)</span><input id="ficha-gim-nota" type="text" maxlength="200" autocomplete="off"${dis}></label>
      </div>
      <div class="ficha__acciones"><button class="boton boton--secundario" type="button" data-ficha-gim-apuntar="${esc(String(id))}"${dis}>Apuntar a esta hora</button></div>`;
  }
  function htmlAccesosFicha(lista) {
    if (!lista || !lista.length) return '<p class="tabla__sub">Sin accesos registrados por el torno.</p>';
    return `<ul class="ficha__lista">${lista.map((x) => `<li>${x.resultado === 'ok'
      ? `<span class="insignia insignia--plazas">${icono('i-check', 13)} ${x.direccion === 'salida' ? 'Salida' : 'Entrada'} permitida</span>`
      : `<span class="insignia insignia--llena">${icono('i-x', 13)} Denegada · ${esc(x.motivo || '')}</span>`} <span class="tabla__sub">${esc(fmtMomento.format(new Date(x.ts)))} · ${x.metodo === 'qr' ? 'QR' : 'pulsera'}</span></li>`).join('')}</ul>`;
  }
  /* Pulsera leída (torno en modo alta o buscador global) que espera a un socio */
  let uidPendiente = '';
  function pintarUidPendiente() {
    const c = $('#uid-pendiente'); if (!c) return;
    c.hidden = !uidPendiente;
    c.innerHTML = uidPendiente
      ? `<div class="aviso-pendiente">${icono('i-nfc')} <span>Pulsera <code class="mono">${esc(uidPendiente)}</code> pendiente de asignar: busca al socio, abre su ficha y pulsa «Guardar pulsera».</span> <button class="boton--texto boton--compacto" type="button" data-olvidar-uid>Descartar</button></div>`
      : '';
  }

  /* ---------- Torno ---------- */

  function pintarSelectorTorno() {
    const conCarnet = vecinos().filter((u) => u.abono);
    $('#torno-abonado').innerHTML = conCarnet.length
      ? conCarnet.map((u) =>
        `<option value="${esc(u.id)}">${esc(u.nombre)} · ${esc(u.abono.nfcUid || u.abono.nfcId || '—')}${abonoVigente(u) ? '' : ' (sin abono en vigor)'}</option>`).join('')
      : '<option value="">No hay carnets emitidos</option>';
  }

  function direccionTorno() {
    const sel = document.querySelector('input[name="torno-direccion"]:checked');
    return sel && sel.value === 'salida' ? 'salida' : 'entrada';
  }

  let tornoTemporizador = null;
  function reaccionTorno(res) {
    const torno = $('#torno');
    const estado = $('#torno-estado');
    const sentido = res.direccion === 'salida' ? 'Salida' : 'Entrada';
    clearTimeout(tornoTemporizador);
    torno.classList.remove('torno--ok', 'torno--mal');
    void torno.offsetWidth; // reinicia la animación
    if (res.resultado === 'ok') {
      torno.classList.add('torno--ok');
      const avisos = res.avisos && res.avisos.length ? ` · ⚠ ${res.avisos.join(' · ')}` : '';
      estado.innerHTML = `${esc(sentido)} permitida<small>${esc(res.usuario.nombre)} · ${esc(res.motivo + avisos)}</small>`;
    } else {
      torno.classList.add('torno--mal');
      estado.innerHTML = `${esc(sentido)} denegada<small>${esc(res.usuario ? res.usuario.nombre + ' · ' : '')}${esc(res.motivo)}</small>`;
    }
    tornoTemporizador = setTimeout(() => {
      torno.classList.remove('torno--ok', 'torno--mal');
      estado.innerHTML = 'En espera<small>Acerca una pulsera o un QR</small>';
    }, 4000);
    // Atajo a la ficha de quien acaba de pasar (se queda hasta la siguiente lectura)
    const acc = $('#torno-acciones');
    if (acc) acc.innerHTML = res.usuario && res.usuario.id
      ? `<button class="boton boton--secundario boton--compacto" type="button" data-abrir-ficha="${esc(String(res.usuario.id))}">Abrir ficha de ${esc(res.usuario.nombre)}</button>` : '';
    marcarAccesosVistos(); // lo generó este panel: no volver a avisarlo por SSE
    if (MSDAuth.modoServidor) pintarAccesosApi(); else pintarAccesos();
  }

  /* ---------- Aviso de acceso EN VIVO ----------
     Cuando llega un acceso desde FUERA (el torno real u otro dispositivo), el
     panel lo muestra al momento con la animación del torno, esté en la sección
     que esté. Los accesos que genera este mismo panel no se reavisan. */
  let ultimoAccesoTs = 0;
  let accesoVivoTimer = null;

  function marcarAccesosVistos() {
    ultimoAccesoTs = MSDAuth.accesos().reduce((m, a) => Math.max(m, a.ts), ultimoAccesoTs);
  }

  function detectarAccesoNuevo() {
    const accesos = MSDAuth.accesos();
    const nuevos = accesos.filter((a) => a.ts > ultimoAccesoTs);
    if (!nuevos.length) return;
    marcarAccesosVistos();
    // el más reciente de los nuevos
    const a = nuevos.reduce((m, x) => (x.ts > m.ts ? x : m), nuevos[0]);
    mostrarAccesoVivo(a, nuevos.length);
  }

  function mostrarAccesoVivo(a, cuantos) {
    const cont = $('#acceso-vivo');
    const vis = $('#acceso-vivo-torno');
    if (!cont || !vis) return;
    const ok = a.resultado === 'ok';
    const sentido = a.direccion === 'salida' ? 'Salida' : 'Entrada';
    const nombre = a.usuarioId ? nombreDe(a.usuarioId) : (a.raw ? a.raw : 'Desconocido');

    cont.classList.toggle('acceso-vivo--ok', ok);
    cont.classList.toggle('acceso-vivo--mal', !ok);
    vis.classList.remove('torno--ok', 'torno--mal');
    void vis.offsetWidth; // reinicia la animación del brazo
    vis.classList.add(ok ? 'torno--ok' : 'torno--mal');

    $('#acceso-vivo-titulo').textContent = ok ? `${sentido} permitida` : `${sentido} denegada`;
    $('#acceso-vivo-nombre').textContent = nombre + (cuantos > 1 ? `  (+${cuantos - 1} más)` : '');
    $('#acceso-vivo-motivo').textContent = `${a.motivo} · ${fmtMomento.format(new Date(a.ts))}`;
    cont.hidden = false;

    clearTimeout(accesoVivoTimer);
    accesoVivoTimer = setTimeout(() => { cont.hidden = true; }, 6500);
  }

  function pintarAccesos() {
    const accesos = MSDAuth.accesos().slice(0, 12);
    const cont = $('#admin-accesos');
    if (!accesos.length) {
      cont.innerHTML = '<div class="aviso-vacio"><strong>Sin accesos registrados</strong></div>';
      return;
    }
    cont.innerHTML = `
      <div class="tabla-envoltura" tabindex="0" role="region" aria-label="Tabla desplazable">
      <table class="tabla">
        <thead><tr>
          <th scope="col">Momento</th><th scope="col">Persona</th><th scope="col">Sentido</th><th scope="col">Método</th><th scope="col">Resultado</th>
        </tr></thead>
        <tbody>
          ${accesos.map((a) => `<tr class="${a.resultado === 'ok' ? '' : 'tabla__fila--mal'}">
            <td data-etiqueta="Momento">${esc(fmtMomento.format(new Date(a.ts)))}</td>
            <td data-etiqueta="Persona">${esc(a.usuarioId ? nombreDe(a.usuarioId) : 'Desconocido')}${a.usuarioId ? ` <button class="boton--texto boton--compacto" type="button" data-abrir-ficha="${esc(a.usuarioId)}">Abrir ficha</button>` : (a.raw ? `<br><span class="tabla__sub mono">${esc(a.raw)}</span>` : '')}</td>
            <td data-etiqueta="Sentido">${a.direccion === 'salida'
              ? '<span class="insignia insignia--neutra">Salida</span>'
              : '<span class="insignia insignia--plazas">Entrada</span>'}</td>
            <td data-etiqueta="Método">${a.metodo === 'qr' ? 'QR' : 'Pulsera NFC'}</td>
            <td data-etiqueta="Resultado">${a.resultado === 'ok'
              ? `<span class="insignia insignia--plazas">${icono('i-check', 13)} Permitido</span>`
              : `<span class="insignia insignia--llena">${icono('i-x', 13)} ${esc(a.motivo)}</span>`}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      </div>`;
  }

  /* ---------- Bloqueos de pista ---------- */

  const PISTAS = INSTALACIONES.flatMap((i) => i.pistas.map((p) => ({ instId: i.id, ...p })));
  const pistaNombre = (id) => { const p = PISTAS.find((x) => x.id === id); return p ? p.nombre : id; };

  const cargarBloqueos = () => {
    const lista = leer('msd_bloqueos', []);
    return Array.isArray(lista) ? lista.filter((b) => b && typeof b === 'object'
      && typeof b.pistaId === 'string' && RE_FECHA.test(String(b.fecha))
      && Number.isInteger(b.desdeMin) && Number.isInteger(b.hastaMin)) : [];
  };

  function pintarBloqueos() {
    // Ventana de reserva vigente
    const config = leer('msd_config', {});
    const desde = Number.isInteger(config.reservaDesdeDias) ? config.reservaDesdeDias : 0;
    const dias = Number.isInteger(config.reservaDiasVentana) ? config.reservaDiasVentana : 14;
    $('#ventana-dias').innerHTML = Array.from({ length: 14 }, (_, i) =>
      `<option value="${i + 1}"${i + 1 === dias ? ' selected' : ''}>${i + 1} día${i ? 's' : ''}</option>`).join('');
    $('#ventana-desde').value = String(Math.min(desde, 3));

    // Controles del formulario
    $('#bloqueo-pista').innerHTML = PISTAS.map((p) =>
      `<option value="${esc(p.id)}">${esc(p.nombre)}</option>`).join('');
    const hoy = new Date();
    $('#bloqueo-fecha').innerHTML = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + i);
      const clave = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      return `<option value="${clave}">${esc(legibleClave(clave))}</option>`;
    }).join('');
    const horas = Array.from({ length: 15 }, (_, i) => 9 + i); // 9..23
    $('#bloqueo-desde').innerHTML = horas.slice(0, -1).map((h) => `<option value="${h * 60}">${pad2(h)}:00</option>`).join('');
    $('#bloqueo-hasta').innerHTML = horas.slice(1).map((h) => `<option value="${h * 60}"${h === 23 ? ' selected' : ''}>${pad2(h)}:00</option>`).join('');

    // Lista de bloqueos activos
    const lista = cargarBloqueos();
    $('#admin-bloqueos').innerHTML = lista.length
      ? lista.map((b) => `
        <div class="tarjeta-reserva">
          <span class="tarjeta-reserva__icono" style="color:var(--error);background:var(--error-tenue)">${icono('i-valla', 22)}</span>
          <div class="tarjeta-reserva__datos">
            <strong>${esc(pistaNombre(b.pistaId))}</strong>
            <span>${esc(legibleClave(b.fecha))} · ${minutosALabel(b.desdeMin)}–${minutosALabel(b.hastaMin)} · ${esc(b.motivo)}</span>
          </div>
          <div class="tarjeta-reserva__acciones">
            <button class="boton--texto" type="button" data-quitar-bloqueo="${esc(b.id)}">Levantar bloqueo</button>
          </div>
        </div>`).join('')
      : '<div class="aviso-vacio"><strong>No hay bloqueos activos</strong>Las pistas están todas disponibles.</div>';
  }

  $('#form-ventana').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const config = {
      reservaDesdeDias: Number($('#ventana-desde').value),
      reservaDiasVentana: Number($('#ventana-dias').value)
    };
    guardar('msd_config', config);
    const nombres = ['hoy', 'mañana', 'dentro de 2 días', 'dentro de 3 días'];
    MSDAuth.anotarAutomatizacion('reservas',
      `Ventana de reserva actualizada: se abre ${nombres[config.reservaDesdeDias]} y quedan ${config.reservaDiasVentana} día(s) disponibles.`);
    avisar('Ventana guardada: la web ya solo enseña esos días.');
  });

  $('#form-bloqueo').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const motivo = $('#bloqueo-motivo').value.trim();
    const desdeMin = Number($('#bloqueo-desde').value);
    const hastaMin = Number($('#bloqueo-hasta').value);
    if (!motivo) {
      $('#error-bloqueo-motivo').textContent = 'Escribe el motivo: el vecino lo verá en la parrilla.';
      $('#error-bloqueo-motivo').hidden = false;
      $('#bloqueo-motivo').setAttribute('aria-invalid', 'true');
      $('#bloqueo-motivo').focus();
      return;
    }
    if (hastaMin <= desdeMin) { avisar('La hora final debe ser posterior a la inicial.', 'error'); return; }
    $('#error-bloqueo-motivo').hidden = true;
    $('#bloqueo-motivo').removeAttribute('aria-invalid');

    const bloqueo = {
      id: `b-${Date.now()}`,
      pistaId: $('#bloqueo-pista').value,
      fecha: $('#bloqueo-fecha').value,
      desdeMin, hastaMin,
      motivo: motivo.slice(0, 60),
      ts: Date.now()
    };
    const lista = cargarBloqueos();
    lista.push(bloqueo);
    guardar('msd_bloqueos', lista);

    // Aviso automático a quien ya tenía reserva en esa franja
    const reservas = cargarReservas();
    const inst = (pid) => INSTALACIONES.find((i) => i.pistas.some((p) => p.id === pid));
    const afectadas = reservas.filter((r) => {
      if (r.pistaId !== bloqueo.pistaId || r.fecha !== bloqueo.fecha) return false;
      const dur = inst(r.pistaId) ? inst(r.pistaId).duracionMin : 60;
      return r.hora < hastaMin && r.hora + dur > desdeMin;
    });
    for (const r of afectadas) {
      if (r.usuarioId) {
        MSDAuth.notificar(r.usuarioId,
          `Tu reserva de ${pistaNombre(r.pistaId)} del ${legibleClave(r.fecha)} a las ${minutosALabel(r.hora)} queda anulada por ${bloqueo.motivo}. La devolución de la liquidación se tramita de oficio: no tienes que hacer nada.`);
      }
    }
    if (afectadas.length) {
      guardar('msd_reservas', reservas.filter((r) => !afectadas.includes(r)));
    }
    MSDAuth.anotarAutomatizacion('reservas',
      `Bloqueo en ${pistaNombre(bloqueo.pistaId)} (${legibleClave(bloqueo.fecha)}, ${minutosALabel(desdeMin)}–${minutosALabel(hastaMin)}) por ${bloqueo.motivo}: ${afectadas.length} reserva(s) anulada(s) con aviso y devolución de oficio.`);
    avisar(afectadas.length
      ? `Pista bloqueada. ${afectadas.length} vecino${afectadas.length > 1 ? 's' : ''} avisado${afectadas.length > 1 ? 's' : ''} automáticamente.`
      : 'Pista bloqueada. No había reservas en esa franja.');
    ev.target.reset();
    pintarBloqueos();
  });

  /* ---------- Panel de ocupación · PLID ---------- */

  /* Misma simulación determinista que la web pública */
  const semilla = (texto) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < texto.length; i++) { h ^= texto.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  };
  function probOcupacion(clave, horaMin, dia) {
    const h = horaMin / 60;
    if (dia >= 1 && dia <= 5) {
      if (h >= 18 && h < 21) return 85;
      if (h >= 21) return 55;
      if (h >= 9 && h < 13) return 15;
      return 38;
    }
    if (dia === 6) return h < 14 ? 88 : 45;
    return h < 14 ? 60 : 30;
  }

  /* Colores de gráfica validados (validate_palette: todos los checks en verde) */
  const G_VERDE = '#2E6FB8';
  const G_ANIL = '#D96C4F';

  function datosOcupacionSemana() {
    const hoy = new Date();
    const porFranja = { '9–13': [], '13–17': [], '17–19': [], '19–21': [], '21–23': [] };
    const porInstalacion = {};
    const porDia = { L: [], M: [], X: [], J: [], V: [], S: [], D: [] };
    const letras = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
    for (let i = 0; i < 7; i++) {
      const d = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + i);
      const clave = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      const dia = d.getDay();
      const cierre = (dia === 0 || dia === 6) ? 21 : 23;
      for (const inst of INSTALACIONES) {
        for (const pista of inst.pistas) {
          for (let h = 9; h < cierre; h++) {
            const ocupada = semilla(`${clave}|${pista.id}|${h * 60}`) % 100 < probOcupacion(clave, h * 60, dia) ? 1 : 0;
            const franja = h < 13 ? '9–13' : h < 17 ? '13–17' : h < 19 ? '17–19' : h < 21 ? '19–21' : '21–23';
            porFranja[franja].push(ocupada);
            (porInstalacion[inst.nombre] = porInstalacion[inst.nombre] || []).push(ocupada);
            porDia[letras[dia]].push(ocupada);
          }
        }
      }
    }
    const media = (l) => l.length ? Math.round(100 * l.reduce((a, b) => a + b, 0) / l.length) : 0;
    return {
      franjas: Object.entries(porFranja).map(([k, v]) => [k, media(v)]),
      instalaciones: Object.entries(porInstalacion).map(([k, v]) => [k, media(v)]),
      dias: ['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((k) => [k, media(porDia[k])])
    };
  }

  /* Barras horizontales accesibles: pista gris tenue, dato verde con remate
     redondeado, etiqueta directa en tinta (nunca en el color de la serie). */
  function htmlBarras(titulo, pares, color) {
    const max = 100;
    return `
      <figure class="grafica" role="group" aria-label="${esc(titulo)}">
        <figcaption class="grafica__titulo">${esc(titulo)}</figcaption>
        ${pares.map(([etiqueta, valor]) => `
          <div class="grafica__fila">
            <span class="grafica__etiqueta">${esc(etiqueta)}</span>
            <span class="grafica__pista"><span class="grafica__dato" style="width:${Math.max(2, valor / max * 100)}%;background:${color}"></span></span>
            <span class="grafica__valor">${valor} %</span>
          </div>`).join('')}
        <table class="visualmente-oculto"><caption>${esc(titulo)}</caption>
          <tbody>${pares.map(([e, v]) => `<tr><th scope="row">${esc(e)}</th><td>${v} %</td></tr>`).join('')}</tbody>
        </table>
      </figure>`;
  }

  function pintarPlid() {
    const datos = datosOcupacionSemana();
    const clases = CLASES.map((c) => {
      const est = estadoClase(c);
      return { nombre: c.nombre, inscritos: est.inscritos, aforo: c.aforo, espera: est.cola };
    }).sort((a, b) => (b.inscritos / b.aforo + b.espera / 10) - (a.inscritos / a.aforo + a.espera / 10));

    const punta = datos.franjas.slice().sort((a, b) => b[1] - a[1])[0];
    const valle = datos.franjas.slice().sort((a, b) => a[1] - b[1])[0];
    const esperaTotal = clases.reduce((n, c) => n + c.espera, 0);
    const mediaGlobal = Math.round(datos.franjas.reduce((n, f) => n + f[1], 0) / datos.franjas.length);

    $('#admin-plid').innerHTML = `
      <div class="plid-cabecera-informe">
        <p><strong>Informe de ocupación</strong> · Complejo Deportivo Prado de la Feria · próximos 7 días · datos de demostración</p>
      </div>
      <div class="kpis">
        <div class="kpi"><strong>${mediaGlobal} %</strong><span>Ocupación media semanal</span></div>
        <div class="kpi"><strong>${esc(punta[0])} h</strong><span>Hora punta (${punta[1]} % de ocupación)</span></div>
        <div class="kpi"><strong>${esc(valle[0])} h</strong><span>Franja con más huecos (${valle[1]} %)</span></div>
        <div class="kpi"><strong>${esperaTotal}</strong><span>Personas en lista de espera — demanda que hoy se pierde sin registrar</span></div>
      </div>
      <div class="plid-graficas">
        ${htmlBarras('Ocupación por franja horaria (%)', datos.franjas, G_VERDE)}
        ${htmlBarras('Ocupación por día de la semana (%)', datos.dias, G_VERDE)}
        ${htmlBarras('Ocupación por instalación (%)', datos.instalaciones, G_VERDE)}
        <figure class="grafica" role="group" aria-label="Demanda de las actividades dirigidas">
          <figcaption class="grafica__titulo">Actividades: plazas ocupadas y lista de espera</figcaption>
          <p class="grafica__leyenda">
            <span><i style="background:${G_VERDE}"></i> Inscritos</span>
            <span><i style="background:${G_ANIL}"></i> En lista de espera</span>
          </p>
          ${clases.map((c) => `
            <div class="grafica__fila">
              <span class="grafica__etiqueta">${esc(c.nombre)}</span>
              <span class="grafica__pista">
                <span class="grafica__dato" style="width:${Math.max(2, c.inscritos / (c.aforo + 8) * 100)}%;background:${G_VERDE}"></span>
                ${c.espera ? `<span class="grafica__dato grafica__dato--segundo" style="width:${c.espera / (c.aforo + 8) * 100}%;background:${G_ANIL}"></span>` : ''}
              </span>
              <span class="grafica__valor">${c.inscritos}/${c.aforo}${c.espera ? ` +${c.espera}` : ''}</span>
            </div>`).join('')}
          <table class="visualmente-oculto"><caption>Actividades: inscritos, aforo y lista de espera</caption>
            <tbody>${clases.map((c) => `<tr><th scope="row">${esc(c.nombre)}</th><td>${c.inscritos} de ${c.aforo}</td><td>${c.espera} en espera</td></tr>`).join('')}</tbody>
          </table>
        </figure>
      </div>
      <p class="plid-nota">Con el sistema en producción, estas cifras dejan de ser una estimación: cada reserva, inscripción y acceso por el torno alimenta directamente el anexo de demanda del PLID.</p>`;
  }

  $('#plid-imprimir').addEventListener('click', () => {
    document.documentElement.classList.add('solo-informe');
    const limpiar = () => document.documentElement.classList.remove('solo-informe');
    window.addEventListener('afterprint', limpiar, { once: true });
    window.print();
    setTimeout(limpiar, 2000);
  });

  document.addEventListener('click', (ev) => {
    const quitar = ev.target.closest('[data-quitar-bloqueo]');
    if (!quitar) return;
    guardar('msd_bloqueos', cargarBloqueos().filter((b) => b.id !== quitar.dataset.quitarBloqueo));
    avisar('Bloqueo levantado: la franja vuelve a estar disponible.');
    pintarBloqueos();
  });

  /* ---------- Tarifas y finanzas ---------- */

  function pintarTarifas() {
    // Campo de euros: el símbolo € va DENTRO del recuadro, a la derecha, para que
    // cada precio se lea claro de un vistazo.
    const campoEuro = (id, valor, etiqueta) =>
      `<span class="tarifa-money"><input class="tarifa-campo" type="number" min="0" step="0.5" id="${id}" value="${valor}" aria-label="${esc(etiqueta)}"><span class="tarifa-euro" aria-hidden="true">€</span></span>`;
    $('#admin-tarifas').innerHTML = `
      <h3 class="etiqueta-grupo" style="margin-top:6px">Alquiler de instalaciones</h3>
      <div class="tabla-envoltura" tabindex="0" role="region" aria-label="Tabla de tarifas">
      <table class="tabla"><thead><tr>
        <th scope="col">Instalación</th><th scope="col">Precio</th><th scope="col">Suplemento de luz</th>
      </tr></thead><tbody>
        ${INSTALACIONES.map((i) => `<tr>
          <td data-etiqueta="Instalación">${esc(i.nombre)} <span style="color:var(--tinta-suave)">/ ${esc(i.unidad)}</span></td>
          <td data-etiqueta="Precio">${campoEuro(`tarifa-precio-${i.id}`, i.precio, 'Precio de ' + i.nombre)}</td>
          <td data-etiqueta="Luz">${i.exterior
            ? campoEuro(`tarifa-luz-${i.id}`, i.suplementoLuz, 'Suplemento de luz de ' + i.nombre)
            : '<span style="color:var(--tinta-suave)">—</span>'}</td>
        </tr>`).join('')}
      </tbody></table></div>

      <h3 class="etiqueta-grupo" style="margin-top:20px">Cuotas mensuales de actividades</h3>
      <div class="tabla-envoltura" tabindex="0" role="region" aria-label="Tabla de cuotas">
      <table class="tabla"><thead><tr>
        <th scope="col">Actividad</th><th scope="col">Cuota al mes</th>
      </tr></thead><tbody>
        ${CLASES.map((c) => `<tr>
          <td data-etiqueta="Actividad">${esc(c.nombre)}</td>
          <td data-etiqueta="Cuota">${campoEuro(`tarifa-clase-${c.id}`, c.precioMes, 'Cuota mensual de ' + c.nombre)}</td>
        </tr>`).join('')}
      </tbody></table></div>

      <h3 class="etiqueta-grupo" style="margin-top:20px">Abono del gimnasio</h3>
      <label class="admin-filtros__campo"><span>Cuota mensual</span>
        ${campoEuro('tarifa-abono', MSDAuth.PRECIO_ABONO, 'Cuota mensual del abono')}
      </label>`;
  }

  $('#form-tarifas').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const num = (id, actual) => {
      const el = $(`#${id}`);
      if (!el) return actual;
      const v = Number(el.value);
      return Number.isFinite(v) && v >= 0 ? v : actual;
    };
    const tarifas = { instalaciones: {}, clases: {}, abono: num('tarifa-abono', MSDAuth.PRECIO_ABONO) };
    for (const i of INSTALACIONES) {
      tarifas.instalaciones[i.id] = {
        precio: num(`tarifa-precio-${i.id}`, i.precio),
        suplementoLuz: i.exterior ? num(`tarifa-luz-${i.id}`, i.suplementoLuz) : i.suplementoLuz
      };
    }
    for (const c of CLASES) tarifas.clases[c.id] = num(`tarifa-clase-${c.id}`, c.precioMes);
    MSDAuth.guardarTarifas(tarifas);
    avisar('Tarifas guardadas: ya se aplican en toda la web.');
    pintarTarifas();
  });

  /* ---------- Gestión total de usuarios ---------- */

  function abrirEditorUsuario(id, opciones) {
    const u = MSDAuth.buscarPorId(id);
    if (!u) return;
    const op = opciones || {};
    const a = u.abono ? { ...u.abono, vigente: abonoVigente(u) } : null;
    const cont = $('#editor-usuario');
    const hoy = MSDAuth.hoy();
    const reservasU = cargarReservas().filter((r) => String(r.usuarioId) === String(u.id) && r.fecha >= hoy)
      .sort((x, y) => (x.fecha === y.fecha ? x.hora - y.hora : (x.fecha < y.fecha ? -1 : 1))).slice(0, 5);
    const clasesU = cargarInscripciones().filter((i) => i.usuarioId === u.id);
    const accesosU = MSDAuth.accesos().filter((x) => x.usuarioId === u.id).slice(0, 5);
    const rolOpc = (v, t) => `<option value="${v}"${u.rol === v ? ' selected' : ''}>${t}</option>`;
    cont.innerHTML = `
      <form class="ficha" data-editor-usuario="${esc(u.id)}" aria-labelledby="ficha-titulo">
        ${htmlFichaCabecera(u, a)}
        <div class="ficha__rejilla">
          <section class="ficha__bloque" aria-labelledby="fb-1">
            <h4 id="fb-1"><span class="ficha__num">1</span> Datos personales</h4>
            <div class="admin-campos">
              <label><span>Nombre</span><input id="editor-nombre" type="text" value="${esc(u.nombre)}" minlength="3" autocomplete="off"></label>
              <label><span>Teléfono</span><input id="editor-telefono" type="tel" value="${esc(u.telefono || '')}" autocomplete="off"></label>
              <label><span>Rol</span><select id="editor-rol">${rolOpc('vecino', 'Vecino/a')}${rolOpc('monitor', 'Monitor/a')}${rolOpc('admin', 'Administración')}</select></label>
              <label><span>Nueva contraseña (opcional, mín. 8)</span><input id="editor-clave" type="text" value="" autocomplete="off"></label>
            </div>
            <div class="ficha__acciones"><button class="boton boton--secundario" type="submit">Guardar datos</button></div>
          </section>
          <section class="ficha__bloque" aria-labelledby="fb-2">
            <h4 id="fb-2"><span class="ficha__num">2</span> Abono</h4>
            <p class="ficha__resumen">${a ? (a.vigente ? `En vigor hasta <strong>${esc(diaLegible(a.hasta))}</strong>${a.autoRenovar ? ' · renovación automática' : ''}` : (a.activo ? `Caducado el ${esc(diaLegible(a.hasta))}.` : 'De baja.')) : 'Sin abono.'}</p>
            <div class="ficha__acciones">
              ${a && a.vigente
                ? `<button class="boton boton--primario" type="button" data-renovar="${esc(u.id)}">Renovar un mes</button><button class="boton--texto es-peligro" type="button" data-baja-abono="${esc(u.id)}">Dar de baja el abono</button>`
                : `<button class="boton boton--primario" type="button" data-activar="${esc(u.id)}">${a ? 'Reactivar el abono' : 'Dar de alta el abono'}</button>`}
            </div>
          </section>
          <section class="ficha__bloque" aria-labelledby="fb-3">
            <h4 id="fb-3"><span class="ficha__num">3</span> Pulsera y QR</h4>
            ${u.abono ? `
            <div class="admin-campos">
              <label><span>UID de la pulsera (decimal)</span><input id="editor-uid" type="text" inputmode="numeric" autocomplete="off" value="${esc(u.abono.nfcUid || '')}" placeholder="p. ej. 1399878112"></label>
              <label><span>Fecha de nacimiento (edad mín. ${MSDAuth.EDAD_MINIMA})</span><input id="editor-nacimiento" type="date" value="${esc(u.birthdate || '')}"></label>
            </div>
            <p class="campo__ayuda">Se guarda con «Guardar datos». Para capturar el UID real, pasa la pulsera por el lector en «modo alta» y cópialo aquí.</p>`
            : '<p class="ficha__resumen">Sin carnet todavía: se emite al dar de alta el abono.</p>'}
          </section>
          <section class="ficha__bloque" aria-labelledby="fb-4">
            <h4 id="fb-4"><span class="ficha__num">4</span> Gimnasio y clases</h4>
            ${htmlBloqueGimnasio(u.id, !!(a && a.vigente))}
            ${clasesU.length ? `<ul class="ficha__lista" style="margin-top:12px">${clasesU.map((i) => `<li><span>${esc(clasePorId(i.claseId).nombre)} <span class="insignia ${i.estado === 'inscrito' ? 'insignia--plazas' : 'insignia--aviso'}">${i.estado === 'inscrito' ? 'inscrito' : 'en lista de espera'}</span></span>${i.estado === 'inscrito' ? `<button class="boton--texto boton--compacto es-peligro" type="button" data-baja-clase="${esc(i.claseId)}" data-usuario="${esc(u.id)}">Dar de baja</button>` : ''}</li>`).join('')}</ul>` : ''}
          </section>
          <section class="ficha__bloque ficha__bloque--ancho" aria-labelledby="fb-5">
            <h4 id="fb-5"><span class="ficha__num">5</span> Actividad y accesos</h4>
            ${reservasU.length
              ? `<ul class="ficha__lista">${reservasU.map((r) => `<li><span>${esc(legibleClave(r.fecha))} · ${minutosALabel(r.hora)} · ${esc(instPorId(r.instId).nombre)} · <span class="mono">${esc(r.localizador)}</span></span><button class="boton--texto boton--compacto es-peligro" type="button" data-cancelar="${esc(r.id)}">Cancelar</button></li>`).join('')}</ul>`
              : '<p class="tabla__sub">Sin reservas próximas.</p>'}
            ${htmlAccesosFicha(accesosU)}
          </section>
        </div>
        <details class="admin-plegable ficha__mas">
          <summary>Más opciones de la cuenta</summary>
          <div class="ficha__peligro"><span>Eliminar la cuenta borra sus reservas e inscripciones. No se puede deshacer.</span><button class="boton boton--secundario es-peligro" type="button" data-eliminar-usuario="${esc(u.id)}">Eliminar la cuenta</button></div>
        </details>
      </form>`;
    abrirFicha();
    enfocarFicha(cont, op.foco);
  }
  /* Foco al abrir la ficha: el campo pedido o, por defecto, el nombre (NUNCA un
     input: si el lector USB dispara sin querer, el UID acabaría en el nombre). */
  function enfocarFicha(cont, foco) {
    const destino = foco && $('#' + foco);
    if (destino) {
      if (!destino.matches('input, select, textarea, button, a, [tabindex]')) destino.setAttribute('tabindex', '-1');
      destino.focus();
      if (destino.tagName !== 'INPUT') destino.scrollIntoView({ block: 'center' });
      return;
    }
    window.scrollTo({ top: Math.max(0, cont.getBoundingClientRect().top + window.scrollY - 96) });
    const t = $('#ficha-titulo'); if (t) t.focus();
  }

  document.addEventListener('submit', async (ev) => {
    const form = ev.target.closest('[data-editor-usuario]');
    if (!form) return;
    ev.preventDefault();
    const id = form.dataset.editorUsuario;
    MSDAuth.adminActualizarUsuario(id, {
      nombre: $('#editor-nombre').value,
      telefono: $('#editor-telefono').value,
      rol: $('#editor-rol').value
    });
    const clave = $('#editor-clave').value;
    if (clave) {
      if (clave.length < 8) { avisar('La contraseña nueva debe tener al menos 8 caracteres.', 'error'); return; }
      await MSDAuth.adminNuevaClave(id, clave);
    }
    // Carnet/acceso: solo si el vecino tiene abono (los campos existen en el form)
    const campoUid = $('#editor-uid');
    if (campoUid) {
      const r = MSDAuth.adminAsignarCarnet(id, {
        nfcUid: campoUid.value,
        birthdate: $('#editor-nacimiento').value
      });
      if (r && r.error) { avisar(r.error, 'error'); return; }
    }
    avisar('Cuenta actualizada.');
    pintarAbonados();
    pintarSelectorTorno();
    abrirEditorUsuario(id, { foco: 'ficha-titulo' });   // la ficha sigue abierta, con los datos nuevos
  });

  document.addEventListener('click', async (ev) => {
    const gestionar = ev.target.closest('[data-gestionar]');
    if (gestionar) { abrirEditorUsuario(gestionar.dataset.gestionar); return; }
    if (ev.target.closest('[data-cerrar-editor]')) { cerrarFicha(); return; }
    const eliminar = ev.target.closest('[data-eliminar-usuario]');
    if (eliminar) {
      const u = MSDAuth.buscarPorId(eliminar.dataset.eliminarUsuario);
      if (!u) return;
      const ok = await confirmar('¿Eliminar esta cuenta?',
        `Se borrarán la cuenta de ${u.nombre}, sus reservas e inscripciones. Esta acción no se puede deshacer.`,
        'Sí, eliminar');
      if (!ok) return;
      MSDAuth.adminEliminarUsuario(u.id);
      guardar('msd_reservas', cargarReservas().filter((r) => r.usuarioId !== u.id));
      guardar('msd_inscripciones', cargarInscripciones().filter((i) => i.usuarioId !== u.id));
      avisar(`Cuenta de ${u.nombre} eliminada.`);
      cerrarFicha();
      pintarAbonados();
    }
  });

  $('#form-crear-usuario').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const nombre = $('#nuevo-nombre').value.trim();
    const email = $('#nuevo-email').value.trim();
    const clave = $('#nuevo-clave').value;
    errorEn('nuevo-nombre', nombre.length < 3 ? 'Escribe el nombre y apellidos (mínimo 3 letras).' : '');
    errorEn('nuevo-email', /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? '' : 'Escribe un correo válido.');
    if (nombre.length < 3 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return;
    if (clave.length < 8) { avisar('En modo local hace falta una contraseña de al menos 8 caracteres.', 'error'); $('#nuevo-clave').focus(); return; }
    const res = await MSDAuth.adminCrearUsuario({
      nombre, email, clave,
      telefono: $('#nuevo-telefono').value,
      rol: $('#nuevo-rol').value
    });
    if (res.error) { avisar(res.error, 'error'); return; }
    avisar(`Cuenta de ${nombre} creada.`);
    ev.target.reset();
    $('#abonados-crear').open = false;
    pintarAbonados();
    // Alta en un hilo: la ficha del recién creado se abre en el paso 2 (abono)
    const nuevo = MSDAuth.usuarios().find((x) => x.email.toLowerCase() === email.toLowerCase());
    if (nuevo) abrirEditorUsuario(nuevo.id, { foco: 'fb-2' });
  });

  /* ---------- Reserva manual desde el panel ---------- */

  function pintarReservaManual() {
    $('#manual-vecino').innerHTML = vecinos().map((u) =>
      `<option value="${esc(u.id)}">${esc(u.nombre)}</option>`).join('') || '<option value="">Sin vecinos</option>';
    $('#manual-pista').innerHTML = PISTAS.map((p) =>
      `<option value="${esc(p.id)}">${esc(p.nombre)}</option>`).join('');
    const hoy = new Date();
    $('#manual-fecha').innerHTML = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + i);
      const clave = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      return `<option value="${clave}">${esc(legibleClave(clave))}</option>`;
    }).join('');
    pintarHorasManual();
  }

  function pintarHorasManual() {
    const pista = PISTAS.find((p) => p.id === $('#manual-pista').value) || PISTAS[0];
    const inst = INSTALACIONES.find((i) => i.id === pista.instId);
    const opciones = [];
    for (let ini = 9 * 60; ini + inst.duracionMin <= 23 * 60; ini += inst.duracionMin) {
      opciones.push(`<option value="${ini}">${minutosALabel(ini)}</option>`);
    }
    $('#manual-hora').innerHTML = opciones.join('');
  }

  document.addEventListener('change', (ev) => {
    if (ev.target.id === 'manual-pista') pintarHorasManual();
  });

  $('#form-reserva-manual').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const usuarioId = $('#manual-vecino').value;
    const u = MSDAuth.buscarPorId(usuarioId);
    const pista = PISTAS.find((p) => p.id === $('#manual-pista').value);
    const inst = INSTALACIONES.find((i) => i.id === pista.instId);
    const fecha = $('#manual-fecha').value;
    const hora = Number($('#manual-hora').value);
    if (!u || !pista) { avisar('Elige vecino y pista.', 'error'); return; }

    const luz = inst.exterior && hora >= 19 * 60;
    const reserva = {
      id: `r-${Date.now()}`,
      localizador: `MS-${(Date.now() % 1679616).toString(36).toUpperCase().padStart(4, '0')}A`,
      instId: inst.id, pistaId: pista.id, fecha, hora,
      precio: inst.precio + (luz ? inst.suplementoLuz : 0),
      nombre: u.nombre, usuarioId: u.id, creada: Date.now()
    };

    // Con servidor, la comprobación es atómica; sin él, se valida en local
    let conflicto = false;
    try {
      const res = await fetch(`/api/reservar?cliente=${typeof MSDSync !== 'undefined' ? MSDSync.idCliente : ''}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reserva, finMin: hora + inst.duracionMin })
      });
      if (res.status === 409) conflicto = true;
      else if (!res.ok) throw new Error('sin api');
      else {
        const lista = cargarReservas();
        if (!lista.some((r) => r.id === reserva.id)) { lista.push(reserva); guardar('msd_reservas', lista); }
      }
    } catch (e) {
      const lista = cargarReservas();
      if (lista.some((r) => r.pistaId === reserva.pistaId && r.fecha === fecha && r.hora === hora)) conflicto = true;
      else { lista.push(reserva); guardar('msd_reservas', lista); }
    }
    if (conflicto) { avisar('Esa hora ya está cogida en esa pista.', 'error'); return; }

    MSDAuth.notificar(u.id,
      `Reserva creada por la oficina: ${pista.nombre}, ${legibleClave(fecha)} a las ${minutosALabel(hora)} (${reserva.localizador}).`);
    MSDAuth.anotarAutomatizacion('reservas',
      `Reserva manual ${reserva.localizador} creada desde el panel para ${u.nombre} (${pista.nombre}, ${legibleClave(fecha)} ${minutosALabel(hora)}).`);
    avisar(`Reserva ${reserva.localizador} creada y vecino avisado.`);
    pintarReservas();
  });

  /* ---------- Automatizaciones ---------- */

  function htmlAutomatizaciones(limite) {
    const lista = MSDAuth.automatizaciones().slice(0, limite || 50);
    if (!lista.length) {
      return '<li style="list-style:none"><div class="aviso-vacio"><strong>Sin actividad todavía</strong></div></li>';
    }
    return lista.map((a) => `
      <li class="tipo-${esc(a.tipo)}">
        <span class="lista-auto__cuando">${esc(fmtMomento.format(new Date(a.ts)))}</span>
        <span>${esc(a.texto)}</span>
      </li>`).join('');
  }

  const pintarAutomatizaciones = () => { $('#admin-auto').innerHTML = htmlAutomatizaciones(50); };

  /* ==========================================================================
     Navegación entre secciones y acciones
     ========================================================================== */

  /* ---------- Gimnasio por horas ---------- */

  let gimAbonadosMap = {};   // "Nombre (email)" → usuarioId, para resolver el datalist

  function pintarGimnasio() {
    const cfg = MSDGimnasio.config();
    const r = MSDGimnasio.resumen();
    $('#gimnasio-resumen').textContent =
      `${r.asignados} apuntados · ${r.espera} en espera · ${r.libres} plazas libres (${r.franjas} franjas × ${cfg.capacidad})`;

    // Datalist de socios con abono en vigor (el value lleva el email para no confundir homónimos).
    // En modo servidor los socios son los de la API (última lista cargada; ver pintores.gimnasio).
    const abonados = (MSDAuth.modoServidor
      ? usuariosApi.filter((u) => u.abono && u.abono.vigente).map((u) => ({ id: String(u.id), nombre: u.nombre, email: u.email }))
      : MSDAuth.usuarios().filter(abonoVigente)).sort((a, b) => a.nombre.localeCompare(b.nombre));
    gimAbonadosMap = {};
    $('#gim-abonados').innerHTML = abonados.map((u) => {
      const etq = `${u.nombre} (${u.email})`;
      gimAbonadosMap[etq] = u.id;
      return `<option value="${esc(etq)}"></option>`;
    }).join('');

    // Select de franjas con su ocupación a la vista.
    $('#gim-franja').innerHTML = opcionesFranjas($('#gim-franja').value);

    // Rejilla de franjas con asignados y lista de espera.
    const filaGente = (g) => `
      <li class="gim-persona">
        <span class="gim-persona__nombre">${g.posicion ? `<span class="gim-cola-num">${g.posicion}º</span> ` : ''}${esc(nombreDe(g.usuarioId))}${g.nota ? ` <span class="gim-persona__nota" title="${esc(g.nota)}" aria-label="Nota: ${esc(g.nota)}">📝</span>` : ''}</span>
        <span class="gim-persona__acc">
          <button class="boton-mini" type="button" data-gim-mover="${g.id}">Mover</button>
          <button class="boton-mini boton-mini--rojo" type="button" data-gim-quitar="${g.id}">Quitar</button>
        </span>
      </li>`;
    $('#gimnasio-franjas').innerHTML = cfg.franjas.map((f) => {
      const o = MSDGimnasio.ocupacion(f);
      const gente = MSDGimnasio.deFranja(f);
      const asignados = gente.filter((g) => g.estado === 'asignado');
      const espera = gente.filter((g) => g.estado === 'espera');
      const pct = Math.min(100, Math.round((o.asignados / o.capacidad) * 100));
      const llena = o.asignados >= o.capacidad;
      const casi = !llena && pct >= 80;
      return `
        <article class="gim-franja${llena ? ' gim-franja--llena' : casi ? ' gim-franja--casi' : ''}">
          <header class="gim-franja__cima">
            <strong>${esc(MSDGimnasio.etiqueta(f))}</strong>
            <span class="insignia ${llena ? 'insignia--llena' : casi ? 'insignia--aviso' : 'insignia--plazas'}">${o.asignados}/${o.capacidad}${o.espera ? ` · ${o.espera} en cola` : ''}</span>
          </header>
          <div class="aforo__barra"><div class="aforo__relleno${llena ? ' aforo__relleno--llena' : ''}" style="width:${pct}%"></div></div>
          ${asignados.length ? `<ul class="gim-lista">${asignados.map(filaGente).join('')}</ul>`
            : '<p class="paso__ayuda" style="margin:.5rem 0 0">Sin nadie apuntado aún.</p>'}
          ${espera.length ? `<p class="etiqueta-grupo" style="margin:.7rem 0 .2rem">Lista de espera</p><ul class="gim-lista gim-lista--espera">${espera.map(filaGente).join('')}</ul>` : ''}
        </article>`;
    }).join('');
  }

  // Alta en persona
  $('#form-gimnasio').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const err = $('#gim-error');
    const mostrar = (m) => { err.textContent = m; err.hidden = false; };
    err.hidden = true;
    const escrito = $('#gim-socio').value.trim();
    let usuarioId = gimAbonadosMap[escrito];
    if (!usuarioId && escrito) {
      // Tolerante: si solo ha escrito el principio del nombre y coincide con una única persona, vale
      const cand = Object.keys(gimAbonadosMap).filter((k) => k.toLowerCase().startsWith(escrito.toLowerCase()));
      if (cand.length === 1) usuarioId = gimAbonadosMap[cand[0]];
    }
    const franja = $('#gim-franja').value;
    const nota = $('#gim-nota').value.trim();
    if (!usuarioId) { mostrar('Elige un socio de la lista (debe tener abono en vigor).'); $('#gim-socio').focus(); return; }
    const u = MSDAuth.modoServidor ? porIdApi(usuarioId) : MSDAuth.buscarPorId(usuarioId);
    const vigente = u && (MSDAuth.modoServidor ? !!(u.abono && u.abono.vigente) : abonoVigente(u));
    if (!u || !vigente) { mostrar('Ese socio no tiene abono en vigor.'); return; }
    if (!franja) { mostrar('Elige una hora.'); return; }
    const res = MSDGimnasio.apuntar(String(usuarioId), franja, nota);
    if (res.error) { mostrar(res.error); return; }
    if (MSDAuth.modoServidor) anotarNombresApi([u]);
    $('#gim-socio').value = ''; $('#gim-nota').value = '';
    pintarGimnasio();
    if (typeof avisar === 'function') {
      avisar(res.estado === 'espera'
        ? `${u.nombre} queda en lista de espera de las ${franja}.`
        : `${u.nombre} apuntado al gimnasio a las ${MSDGimnasio.etiqueta(franja)}.`);
    }
  });

  // Apuntar desde la ficha del socio (bloque 4)
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-ficha-gim-apuntar]'); if (!b) return;
    const id = b.dataset.fichaGimApuntar;
    const franja = $('#ficha-gim-franja') && $('#ficha-gim-franja').value;
    const nota = ($('#ficha-gim-nota') && $('#ficha-gim-nota').value.trim()) || '';
    if (!franja) { avisar('Elige una hora.', 'error'); return; }
    const res = MSDGimnasio.apuntar(String(id), franja, nota);
    if (res.error) { errorEditorApi(res.error); avisar(res.error, 'error'); return; }
    avisar(res.estado === 'espera' ? `Queda en lista de espera de las ${MSDGimnasio.etiqueta(franja)}.` : `Apuntado al gimnasio a las ${MSDGimnasio.etiqueta(franja)}.`);
    refrescarFichaAbierta();
  });

  // Mover (despliega un selector en línea) / Quitar
  document.addEventListener('click', async (ev) => {
    const mover = ev.target.closest('[data-gim-mover]');
    if (mover) {
      const acc = mover.closest('.gim-persona__acc');
      const id = mover.dataset.gimMover;
      acc.innerHTML = `<select class="gim-mover-sel" data-gim-mover-sel="${id}" aria-label="Mover a otra hora">
        <option value="">Mover a…</option>
        ${opcionesFranjas()}
      </select>`;
      const sel = acc.querySelector('select'); if (sel) sel.focus();
      return;
    }
    const quitar = ev.target.closest('[data-gim-quitar]');
    if (quitar) {
      const g = MSDGimnasio.leer().find((x) => x.id === quitar.dataset.gimQuitar);
      const ok = await confirmar('¿Quitar del gimnasio?', `${g ? nombreDe(g.usuarioId) : 'Esta persona'} saldrá de las ${g ? MSDGimnasio.etiqueta(g.franja) : 'su hora'}; si hay lista de espera, la siguiente persona sube.`, 'Sí, quitar');
      if (!ok) return;
      MSDGimnasio.quitar(quitar.dataset.gimQuitar);
      pintarGimnasio();
      refrescarFichaAbierta();
    }
  });
  document.addEventListener('change', (ev) => {
    const sel = ev.target.closest('[data-gim-mover-sel]');
    if (sel && sel.value) { MSDGimnasio.mover(sel.dataset.gimMoverSel, sel.value); pintarGimnasio(); refrescarFichaAbierta(); }
  });

  const pintores = {
    panel: pintarPanel,
    reservas: () => { pintarReservaManual(); pintarReservas(); },
    clases: pintarClases,
    abonados: pintarAbonados,
    gimnasio: pintarGimnasio,
    tarifas: pintarTarifas,
    instalaciones: pintarBloqueos,
    plid: pintarPlid,
    torno: () => { pintarSelectorTorno(); pintarAccesos(); },
    automatizaciones: pintarAutomatizaciones
  };

  let seccionActual = 'panel';

  /* Muestra una sección (sin pintarla): menú, aria-current, cámara apagada fuera del torno */
  function activarSeccion(nombre) {
    if (nombre !== 'torno') pararCamara(); // no dejar la cámara encendida en segundo plano
    seccionActual = nombre;
    $$('#admin-menu button').forEach((b) => {
      if (b.dataset.seccion === nombre) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });
    $$('.admin-seccion').forEach((s) => { s.hidden = s.id !== `seccion-${nombre}`; });
  }
  function irASeccion(nombre) {
    activarSeccion(nombre);
    pintores[nombre]();
  }

  $('#admin-menu').addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-seccion]');
    if (!boton) return;
    irASeccion(boton.dataset.seccion);
    // anuncia el cambio: el foco va al título de la sección (solo al navegar a mano)
    const h = $(`#seccion-${boton.dataset.seccion} h2`);
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  });

  /* Atajos del inicio y enlaces internos: data-ir = sección, data-abrir = <details>, data-foco = campo */
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-ir], [data-abrir], [data-foco]');
    if (!b || b.closest('#admin-menu')) return;
    if (b.dataset.ir) irASeccion(b.dataset.ir);
    if (b.dataset.abrir) { const d = $('#' + b.dataset.abrir); if (d) d.open = true; }
    if (b.dataset.foco) requestAnimationFrame(() => { const f = $('#' + b.dataset.foco); if (f) { f.focus(); if (f.scrollIntoView) f.scrollIntoView({ block: 'center' }); } });
  });

  /* Fila de socio clicable (entera), «+ Nuevo vecino», reintentar, descartar pulsera pendiente */
  document.addEventListener('click', (ev) => {
    const fila = ev.target.closest('tr[data-api-fila], tr[data-fila]');
    if (fila && !ev.target.closest('button, a, input, select, label')) {
      if (fila.dataset.apiFila) abrirEditorApi(fila.dataset.apiFila); else abrirEditorUsuario(fila.dataset.fila);
      return;
    }
    if (ev.target.closest('#abonados-nuevo')) { const d = $('#abonados-crear'); d.open = true; $('#nuevo-nombre').focus(); return; }
    if (ev.target.closest('#abonados-reintentar')) { pintarAbonadosApi(); return; }
    if (ev.target.closest('[data-olvidar-uid]')) { uidPendiente = ''; pintarUidPendiente(); }
  });

  /* Búsqueda y filtro de socios: los controles son estáticos (admin.html), solo se repinta la tabla */
  document.addEventListener('input', (ev) => {
    if (ev.target.id !== 'buscar-abonado') return;
    busquedaAbonados = ev.target.value;
    if (MSDAuth.modoServidor) {
      clearTimeout(pintarAbonadosApi._t);
      pintarAbonadosApi._t = setTimeout(pintarAbonadosApi, 350);
    } else pintarAbonados();
  });
  document.addEventListener('change', (ev) => {
    if (ev.target.id === 'filtro-reservas-inst') {
      filtroReservasInst = ev.target.value;
      pintarReservas();
    } else if (ev.target.id === 'filtro-reservas-proximas') {
      soloProximas = ev.target.checked;
      pintarReservas();
    } else if (ev.target.id === 'filtro-abono-api') {
      filtroAbonoApi = ev.target.value;
      if (MSDAuth.modoServidor) pintarAbonadosApi(); else pintarAbonados();
    }
  });

  /* Buscador global de la cabecera: nombre, correo o la pulsera que teclea el lector USB.
     Un único resultado → abre la ficha; una pulsera desconocida → queda pendiente de asignar. */
  $('#form-buscar-global').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const q = $('#buscar-global').value.trim(); if (!q) return;
    const n = MSDUid.normalizar(q);
    const qApi = (n.ok && n.formato === 'hex') ? n.principal : q;   // la API compara nfc_uid exacto en decimal
    busquedaAbonados = qApi; filtroAbonoApi = '';
    cerrarFicha();
    activarSeccion('abonados');
    $('#buscar-abonado').value = qApi; $('#filtro-abono-api').value = '';
    let lista;
    if (MSDAuth.modoServidor) { await pintarAbonadosApi(); lista = usuariosApi; }
    else {
      const t = qApi.toLowerCase();
      lista = vecinos().filter((u) => u.nombre.toLowerCase().includes(t) || u.email.toLowerCase().includes(t) || (u.abono && u.abono.nfcUid === qApi));
      pintarAbonados();
    }
    $('#buscar-global').value = '';
    if (lista.length === 1) { (MSDAuth.modoServidor ? abrirEditorApi : abrirEditorUsuario)(lista[0].id); return; }
    if (!lista.length && n.ok) {
      uidPendiente = n.principal; pintarUidPendiente();
      avisar('Pulsera no registrada: busca al socio, abre su ficha y pulsa «Guardar pulsera».', 'error');
    }
    $('#buscar-abonado').focus();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'F2' && !$('#admin-app').hidden) { ev.preventDefault(); $('#buscar-global').focus(); }
  });

  /* Lector USB «tipo teclado» sin foco en ningún campo: una ráfaga rápida de caracteres + Enter
     se lleva al campo que la espera (ficha abierta → pulsera; sección Torno → validar;
     si no → buscador global). Nunca toca el texto de otro campo. */
  let rafaga = '', rafagaTs = 0;
  document.addEventListener('keydown', (ev) => {
    if ($('#admin-app').hidden || ev.ctrlKey || ev.metaKey || ev.altKey) { rafaga = ''; return; }
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && !/^(checkbox|radio)$/.test(ae.type)) { rafaga = ''; return; }
    const t = performance.now();
    if (ev.key.length === 1) { if (t - rafagaTs > 60) rafaga = ''; rafaga += ev.key; rafagaTs = t; return; }
    if (ev.key !== 'Enter') return;
    const lectura = rafaga; rafaga = '';
    if (lectura.length < 6 || t - rafagaTs > 150) return;
    ev.preventDefault();
    const campoFicha = $('#ea-uid');
    if (campoFicha && seccionActual === 'abonados' && !$('#editor-usuario').hidden) {   // ficha visible
      campoFicha.value = lectura; mostrarInfoUid(lectura); campoFicha.focus();
      const b = $('[data-api-pulsera]'); if (b) b.classList.add('boton--destacado');
      return;
    }
    if (seccionActual === 'torno') { const c = $('#torno-manual'); if (c) { c.value = lectura; $('#torno-validar-manual').click(); } return; }
    const g = $('#buscar-global'); if (g && !g.form.hidden) { g.value = lectura; g.form.requestSubmit(); }
  });

  document.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-cancelar], [data-simular-baja], [data-baja-clase], [data-activar], [data-renovar], [data-baja-abono]');
    if (!el) return;

    if (el.dataset.cancelar) {
      const reservas = cargarReservas();
      const r = reservas.find((x) => x.id === el.dataset.cancelar);
      if (!r) return;
      const ok = await confirmar('¿Cancelar esta reserva?',
        `${instPorId(r.instId).nombre} · ${legibleClave(r.fecha)} a las ${minutosALabel(r.hora)} de ${r.usuarioId ? nombreDe(r.usuarioId) : (r.nombre || 'un vecino')}. Se avisará por correo.`,
        'Sí, cancelar');
      if (!ok) return;
      guardar('msd_reservas', reservas.filter((x) => x.id !== r.id));
      MSDAuth.anotarAutomatizacion('reservas',
        `Reserva ${r.localizador} cancelada desde el panel: aviso y devolución tramitados automáticamente.`);
      avisar('Reserva cancelada y vecino avisado.');
      if (seccionActual === 'reservas') pintarReservas();
      refrescarFichaAbierta();
      return;
    }

    if (el.dataset.simularBaja) {
      const clase = clasePorId(el.dataset.simularBaja);
      const ajustes = cargarAjustes();
      ajustes[clase.id] = { inscritosBase: Math.max(0, baseInscritos(clase) - 1), colaBase: baseCola(clase) };
      guardar('msd_clases_ajustes', ajustes);
      promocionarCola(clase);
      avisar(`Baja simulada en ${clase.nombre}. Si había cola, la siguiente persona ya está dentro.`);
      pintarClases();
      return;
    }

    if (el.dataset.bajaClase) {
      const clase = clasePorId(el.dataset.bajaClase);
      const quien = nombreDe(el.dataset.usuario);
      const ok = await confirmar('¿Dar de baja de la clase?',
        `${quien} saldrá de ${clase.nombre}. Su plaza pasará automáticamente a la lista de espera.`,
        'Sí, dar de baja');
      if (!ok) return;
      const inscripciones = cargarInscripciones()
        .filter((i) => !(i.claseId === clase.id && i.usuarioId === el.dataset.usuario && i.estado === 'inscrito'));
      guardar('msd_inscripciones', inscripciones);
      promocionarCola(clase);
      avisar(`${quien} dado de baja de ${clase.nombre}.`);
      pintarClases();
      refrescarFichaAbierta();   // si se hizo desde la ficha del socio, que se vea al momento
      return;
    }

    if (el.dataset.activar) {
      MSDAuth.activarAbono(el.dataset.activar, true);
      avisar('Abono activado y carnet emitido.');
      pintarAbonados();
      refrescarFichaAbierta();
      return;
    }
    if (el.dataset.renovar) {
      const u = MSDAuth.buscarPorId(el.dataset.renovar);
      const ok = await confirmar('¿Renovar un mes?', `${u ? u.nombre : 'Este vecino'}: el abono se alargará un mes desde su fecha de caducidad.`, 'Sí, renovar');
      if (!ok) return;
      MSDAuth.renovarAbono(el.dataset.renovar, true);
      const u2 = MSDAuth.buscarPorId(el.dataset.renovar);
      avisar(`Abono renovado${u2 && u2.abono ? ' hasta el ' + diaLegible(u2.abono.hasta) : ' un mes'}.`);
      pintarAbonados();
      refrescarFichaAbierta();
      return;
    }
    if (el.dataset.bajaAbono) {
      const u = MSDAuth.buscarPorId(el.dataset.bajaAbono);
      const ok = await confirmar('¿Dar de baja el abono?',
        `El torno dejará de aceptar el carnet de ${u ? u.nombre : 'este vecino'} desde ahora.`,
        'Sí, dar de baja');
      if (!ok) return;
      MSDAuth.bajaAbono(el.dataset.bajaAbono);
      avisar('Abono dado de baja.');
      pintarAbonados();
      refrescarFichaAbierta();
      return;
    }
  });

  /* ---------- Cámara: lector real de QR en el torno ---------- */

  let camaraFlujo = null;
  let camaraRAF = null;

  function mensajeCamara(e) {
    switch (e && e.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Permiso de cámara denegado. Actívalo en el navegador (icono del candado → Cámara → Permitir) y reintenta.';
      case 'NotFoundError':
      case 'OverconstrainedError':
      case 'DevicesNotFoundError':
        return 'No se detecta ninguna cámara. Comprueba que esté conectada y que el sistema permita el acceso (en Windows: Ajustes → Privacidad y seguridad → Cámara → activa el acceso para las aplicaciones de escritorio).';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'La cámara está ocupada por otra aplicación (Zoom, Teams, Meet, otra pestaña…). Ciérrala y reintenta.';
      default:
        return `No se pudo abrir la cámara${e && e.name ? ' (' + e.name + ')' : ''}. Prueba con Chrome/Edge/Firefox actualizado y sobre HTTPS.`;
    }
  }

  /* Pide la cámara con tolerancia: preferimos la trasera (móvil) pero caemos a
     cualquiera (PC con webcam frontal). Con deviceId abre esa cámara concreta. */
  async function obtenerFlujoCamara(deviceId) {
    const intentos = deviceId
      ? [{ video: { deviceId: { exact: deviceId } }, audio: false }]
      : [
          { video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 } }, audio: false },
          { video: true, audio: false }
        ];
    let ultimoError;
    for (const restr of intentos) {
      try { return await navigator.mediaDevices.getUserMedia(restr); }
      catch (e) { ultimoError = e; if (e.name === 'NotAllowedError') throw e; }
    }
    throw ultimoError;
  }

  async function poblarSelectorCamaras() {
    const sel = $('#torno-camara-sel');
    if (!sel || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      if (cams.length <= 1) { sel.hidden = true; return; }
      const track = camaraFlujo && camaraFlujo.getVideoTracks()[0];
      const actualId = track && track.getSettings ? track.getSettings().deviceId : '';
      sel.innerHTML = cams.map((c, i) =>
        `<option value="${esc(c.deviceId)}"${c.deviceId === actualId ? ' selected' : ''}>${esc(c.label || ('Cámara ' + (i + 1)))}</option>`).join('');
      sel.hidden = false;
    } catch (e) { sel.hidden = true; }
  }

  async function arrancarCamara(deviceId) {
    if (typeof jsQR === 'undefined') {
      avisar('El lector de QR (jsQR) no está cargado.', 'error');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      avisar('Este navegador no permite usar la cámara. Ábrelo en Chrome/Edge/Firefox actualizado y sobre HTTPS.', 'error');
      return;
    }
    // Si se está cambiando de cámara, cierra la anterior primero.
    cancelAnimationFrame(camaraRAF);
    if (camaraFlujo) { camaraFlujo.getTracks().forEach((t) => t.stop()); camaraFlujo = null; }

    try {
      camaraFlujo = await obtenerFlujoCamara(deviceId);
    } catch (e) {
      avisar(mensajeCamara(e), 'error');
      pararCamara();
      return;
    }
    const video = $('#torno-video');
    $('#torno-camara-zona').hidden = false;
    $('#torno-camara-boton').hidden = true;
    video.srcObject = camaraFlujo;
    await video.play().catch(() => {});
    poblarSelectorCamaras();

    const lienzo = document.createElement('canvas');
    const ctx = lienzo.getContext('2d', { willReadFrequently: true });
    let ultimaLectura = '';

    const bucle = () => {
      if (!camaraFlujo) return;
      if (video.readyState >= 2 && video.videoWidth) {
        lienzo.width = video.videoWidth;
        lienzo.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const imagen = ctx.getImageData(0, 0, lienzo.width, lienzo.height);
        const qr = jsQR(imagen.data, lienzo.width, lienzo.height);
        if (qr && qr.data && qr.data !== ultimaLectura) {
          ultimaLectura = qr.data;
          if (MSDAuth.modoServidor && window.__msdValidarLectura) window.__msdValidarLectura(qr.data);
          else Promise.resolve(MSDAuth.validarAccesoQr(qr.data, direccionTorno())).then(reaccionTorno);
          setTimeout(() => { ultimaLectura = ''; }, 3000); // re-escaneo tras 3 s
        }
      }
      camaraRAF = requestAnimationFrame(bucle);
    };
    bucle();
  }

  function pararCamara() {
    cancelAnimationFrame(camaraRAF);
    if (camaraFlujo) camaraFlujo.getTracks().forEach((t) => t.stop());
    camaraFlujo = null;
    const video = $('#torno-video');
    if (video) video.srcObject = null;
    const zona = $('#torno-camara-zona');
    if (zona) zona.hidden = true;
    const sel = $('#torno-camara-sel');
    if (sel) sel.hidden = true;
    const boton = $('#torno-camara-boton');
    if (boton) boton.hidden = false;
  }

  $('#torno-camara-boton').addEventListener('click', () => arrancarCamara());
  $('#torno-camara-parar').addEventListener('click', pararCamara);
  const selCamara = $('#torno-camara-sel');
  if (selCamara) selCamara.addEventListener('change', (e) => arrancarCamara(e.target.value));
  window.addEventListener('beforeunload', pararCamara);

  /* ---------- Exportar CSV ---------- */

  function descargarCSV(nombre, filas) {
    const csv = String.fromCharCode(0xFEFF) + filas /* BOM para que Excel abra el UTF-8 bien */
      .map((f) => f.map((c) => `"${String(c === null || c === undefined ? '' : c).replace(/"/g, '""')}"`).join(';'))
      .join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const enlace = document.createElement('a');
    enlace.href = URL.createObjectURL(blob);
    enlace.download = nombre;
    enlace.click();
    setTimeout(() => URL.revokeObjectURL(enlace.href), 5000);
    avisar(`Descargado ${nombre}.`);
  }

  $('#csv-reservas').addEventListener('click', () => {
    const filas = [['Localizador', 'Vecino/a', 'Instalación', 'Pista', 'Fecha', 'Hora', 'Importe €']];
    for (const r of cargarReservas()) {
      const inst = instPorId(r.instId);
      const pista = inst.pistas.find((p) => p.id === r.pistaId);
      filas.push([r.localizador, r.usuarioId ? nombreDe(r.usuarioId) : (r.nombre || ''), inst.nombre,
        pista ? pista.nombre : '', r.fecha, minutosALabel(r.hora), (r.precio || 0).toFixed(2).replace('.', ',')]);
    }
    descargarCSV('reservas-medina-sidonia.csv', filas);
  });

  $('#csv-abonados').addEventListener('click', () => {
    const filas = [['Nombre', 'Correo', 'Teléfono', 'Estado del abono', 'Válido hasta', 'UID tarjeta', 'Nacimiento', 'Renovación automática']];
    for (const u of vecinos()) {
      filas.push([u.nombre, u.email, u.telefono || '',
        !u.abono ? 'Sin abono' : (abonoVigente(u) ? 'En vigor' : (u.abono.activo ? 'Caducado' : 'De baja')),
        u.abono ? u.abono.hasta : '', u.abono ? (u.abono.nfcUid || u.abono.nfcId || '') : '',
        u.birthdate || '',
        u.abono && u.abono.autoRenovar ? 'Sí' : 'No']);
    }
    descargarCSV('abonados-medina-sidonia.csv', filas);
  });

  $('#csv-accesos').addEventListener('click', () => {
    const filas = [['Momento', 'Persona', 'Sentido', 'Método', 'Resultado', 'Motivo', 'Valor leído']];
    for (const a of MSDAuth.accesos()) {
      filas.push([fmtMomento.format(new Date(a.ts)), a.usuarioId ? nombreDe(a.usuarioId) : 'Desconocido',
        a.direccion === 'salida' ? 'Salida' : 'Entrada',
        a.metodo === 'qr' ? 'QR' : 'Pulsera NFC', a.resultado === 'ok' ? 'Permitido' : 'Denegado', a.motivo, a.raw || '']);
    }
    descargarCSV('accesos-medina-sidonia.csv', filas);
  });

  /* Torno */
  $('#torno-leer-nfc').addEventListener('click', () => {
    const u = MSDAuth.buscarPorId($('#torno-abonado').value);
    if (!u || !u.abono) { avisar('Elige un abonado con carnet.', 'error'); return; }
    reaccionTorno(MSDAuth.validarAcceso(u.abono.nfcUid || u.abono.nfcId, 'nfc', direccionTorno()));
  });
  $('#torno-leer-qr').addEventListener('click', async () => {
    const u = MSDAuth.buscarPorId($('#torno-abonado').value);
    if (!u || !u.abono) { avisar('Elige un abonado con carnet.', 'error'); return; }
    const carnet = await MSDAuth.cargaQrDinamica(u);
    if (!carnet) { avisar('Este carnet aún no tiene QR dinámico.', 'error'); return; }
    reaccionTorno(await MSDAuth.validarAccesoQr(carnet.payload, direccionTorno()));
  });
  $('#torno-validar-manual').addEventListener('click', async () => {
    const texto = $('#torno-manual').value.trim();
    if (!texto) { avisar('Pega primero el contenido de un QR o un UID.', 'error'); return; }
    // El validador decide solo si es una tarjeta conocida o un token de QR.
    reaccionTorno(await MSDAuth.validarAccesoQr(texto, direccionTorno()));
  });

  /* ==========================================================================
     Puerta de entrada
     ========================================================================== */

  function errorEn(id, mensaje) {
    const campo = $(`#${id}`);
    const error = $(`#error-${id}`);
    if (!campo) { if (mensaje) avisar(mensaje, 'error'); return; }
    if (mensaje) {
      campo.setAttribute('aria-invalid', 'true');
      if (error) { error.textContent = mensaje; error.hidden = false; } else avisar(mensaje, 'error');
    } else {
      campo.removeAttribute('aria-invalid');
      if (error) error.hidden = true;
    }
  }

  let chipTornoTimer = null;
  function mostrarApp(u) {
    $('#admin-login').hidden = true;
    $('#admin-app').hidden = false;
    $('#admin-salir').hidden = false;
    const hola = $('#admin-hola');
    hola.textContent = `Sesión de ${u.nombre}`; hola.title = `${u.nombre} · ${u.email}`; hola.hidden = false;
    $('#form-buscar-global').hidden = false;
    if (MSDAuth.modoServidor) {
      $('#chip-torno').hidden = false;
      refrescarEstadoTorno();
      clearInterval(chipTornoTimer);
      chipTornoTimer = setInterval(refrescarEstadoTorno, 20000);
    }
    irASeccion(seccionActual);
  }

  function mostrarLogin() {
    $('#admin-login').hidden = false;
    $('#admin-app').hidden = true;
    $('#admin-salir').hidden = true;
    $('#admin-hola').hidden = true;
    $('#form-buscar-global').hidden = true;
    $('#chip-torno').hidden = true;
    clearInterval(chipTornoTimer);
  }

  // Sesión caducada en el servidor (401 en cualquier llamada): vuelta a la puerta, con el motivo
  if (typeof MSDApi !== 'undefined') {
    MSDApi.al401(() => {
      if ($('#admin-app').hidden) return;
      mostrarLogin();
      errorEn('admin-email', 'La sesión ha caducado: vuelve a entrar.');
      $('#admin-email').focus();
    });
  }

  $('#form-admin-login').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = $('#admin-email').value.trim();
    const clave = $('#admin-clave').value;
    errorEn('admin-email', email ? '' : 'Escribe el correo.');
    errorEn('admin-clave', clave ? '' : 'Escribe la contraseña.');
    if (!email || !clave) return;
    const res = await MSDAuth.entrar(email, clave);
    if (res.error) {
      // Mensaje único para no delatar si el correo existe
      errorEn('admin-clave', res.error);
      $('#admin-clave').focus();
      return;
    }
    if (res.usuario.rol !== 'admin') {
      MSDAuth.salir();
      errorEn('admin-email', 'Esta cuenta no tiene permisos de administración.');
      $('#admin-email').focus();
      return;
    }
    avisar(`Bienvenido, ${res.usuario.nombre}.`);
    mostrarApp(res.usuario);
  });

  $('#admin-salir').addEventListener('click', () => {
    MSDAuth.salir();
    mostrarLogin();
    avisar('Sesión cerrada.');
  });

  MSDAuth.listo.then(() => {
    const u = MSDAuth.sesionActual();
    if (u && u.rol === 'admin') mostrarApp(u);
    else mostrarLogin();
    marcarAccesosVistos(); // punto de partida: no avisar de accesos ya existentes
    // Eventos en directo del servidor: el panel se repinta al momento
    MSDSync.escuchar((clave) => {
      MSDAuth.recargar();
      const enApp = !$('#admin-app').hidden;
      // Un acceso llegado de fuera (torno real u otro dispositivo): avísalo en vivo
      if (clave === 'msd_accesos' && enApp) detectarAccesoNuevo();
      // no machacar una ficha a medio editar; el resto se repinta (los controles son estáticos: no roban el foco)
      if (enApp && !(seccionActual === 'abonados' && !$('#editor-usuario').hidden)) irASeccion(seccionActual);
    });
  });

  // Cerrar el aviso en vivo a mano
  const cerrarVivo = $('#acceso-vivo-cerrar');
  if (cerrarVivo) cerrarVivo.addEventListener('click', () => { $('#acceso-vivo').hidden = true; });

  /* ==========================================================================
     MODO SERVIDOR (F3): Abonados y Torno sobre la API (/api/admin/*)
     Se activa cuando MSDAuth.modoServidor es true (hay BD). Sustituye las
     funciones legadas de estas dos secciones; el resto del panel sigue con
     el estado legado hasta F4–F6.
     ========================================================================== */
  let usuariosApi = [];            // última lista de /api/admin/usuarios (vistaUsuarioAdmin + abono)
  const porIdApi = (id) => usuariosApi.find((u) => String(u.id) === String(id));

  /* Carga la lista (con la búsqueda y el filtro actuales, o todos). Devuelve la lista
     o { error } — un fallo de red NO debe disfrazarse de «Sin resultados». */
  async function cargarUsuariosApi(todos) {
    const q = new URLSearchParams();
    if (!todos) {
      if (busquedaAbonados.trim()) q.set('q', busquedaAbonados.trim());
      if (filtroAbonoApi) q.set('abono', filtroAbonoApi);
    }
    const r = await MSDApi.get('/api/admin/usuarios' + (q.toString() ? '?' + q.toString() : ''));
    if (!r.ok) return { error: r.error || 'No se ha podido conectar.' };
    usuariosApi = r.datos.usuarios || [];
    anotarNombresApi(usuariosApi);
    return usuariosApi;
  }

  async function pintarAbonadosApi() {
    const cont = $('#admin-abonados');
    cont.setAttribute('aria-busy', 'true');            // la tabla anterior se atenúa mientras llega la nueva
    if (!cont.innerHTML.trim()) cont.innerHTML = '<div class="aviso-vacio">Cargando…</div>';
    const res = await cargarUsuariosApi();
    cont.setAttribute('aria-busy', 'false');
    if (res.error) {
      cont.innerHTML = `<div class="aviso-vacio aviso-vacio--error" role="alert"><strong>No se ha podido cargar la lista</strong>${esc(res.error)} <button class="boton boton--secundario" type="button" id="abonados-reintentar">Reintentar</button></div>`;
      return;
    }
    if (!res.length) { cont.innerHTML = '<div class="aviso-vacio"><strong>Sin resultados</strong>Prueba con otro nombre, correo o UID de pulsera.</div>'; return; }
    cont.innerHTML = tablaSocios(res, false);
  }

  /* Ficha del socio (modo servidor). Mismos ids y data-atributos de siempre. */
  function abrirEditorApi(id, opciones) {
    const u = porIdApi(id); if (!u) return;
    const a = u.abono || {};
    const op = opciones || {};
    const cont = $('#editor-usuario');
    const rolOpc = (v, t) => `<option value="${v}"${u.rol === v ? ' selected' : ''}>${t}</option>`;
    cont.innerHTML = `
      <form class="ficha" data-editor-api="${u.id}" aria-labelledby="ficha-titulo">
        ${htmlFichaCabecera(u, u.abono)}
        <div class="ficha__rejilla">
          <section class="ficha__bloque" aria-labelledby="fb-1">
            <h4 id="fb-1"><span class="ficha__num">1</span> Datos personales</h4>
            <div class="admin-campos">
              <label><span>Nombre</span><input id="ea-nombre" type="text" value="${esc(u.nombre)}" minlength="3" autocomplete="off"></label>
              <label><span>Teléfono</span><input id="ea-telefono" type="tel" value="${esc(u.telefono || '')}" autocomplete="off"></label>
              <label><span>Fecha de nacimiento (edad mín. 16)</span><input id="ea-nacimiento" type="date" value="${esc(u.birthdate || '')}"></label>
              <label><span>Rol</span><select id="ea-rol">${rolOpc('vecino', 'Vecino/a')}${rolOpc('monitor', 'Monitor/a')}${rolOpc('admin', 'Administración')}</select></label>
            </div>
            <div class="ficha__acciones"><button class="boton boton--secundario" type="submit">Guardar datos</button></div>
          </section>
          <section class="ficha__bloque" aria-labelledby="fb-2">
            <h4 id="fb-2"><span class="ficha__num">2</span> Abono</h4>
            <p class="ficha__resumen">${a.vigente
              ? `En vigor hasta <strong>${esc(diaLegible(a.hasta))}</strong>${a.autoRenovar ? ' · se renueva solo cada mes (recibo domiciliado)' : ''}`
              : a.hasta ? `Caducado el ${esc(diaLegible(a.hasta))}: elige los meses y pulsa «Reactivar».` : 'Sin abono: el primer pago es con tarjeta en recepción; los meses siguientes van domiciliados si marcas la renovación automática.'}</p>
            <div class="admin-campos">
              <label><span>Meses a dar de alta / añadir</span><input id="ea-meses" type="number" min="1" max="12" value="1" inputmode="numeric"></label>
              <label class="admin-campos__check"><input id="ea-auto" type="checkbox"${a.autoRenovar ? ' checked' : ''}> Renovación automática (domiciliación)</label>
            </div>
            <div id="ficha-recibos"><p class="tabla__sub">Cargando recibos…</p></div>
            <div class="ficha__acciones">
              <button class="boton boton--primario" type="button" data-api-alta-editor="${u.id}">${a.vigente ? 'Añadir meses' : (a.hasta ? 'Reactivar el abono' : 'Dar de alta el abono')}</button>
              ${a.vigente ? `<button class="boton--texto es-peligro" type="button" data-api-baja="${u.id}">Dar de baja el abono</button>` : ''}
            </div>
          </section>
          <section class="ficha__bloque" aria-labelledby="fb-3">
            <h4 id="fb-3"><span class="ficha__num">3</span> Pulsera y QR</h4>
            <div class="campo-lector" id="campo-lector-ea">
              <label for="ea-uid">UID de la pulsera</label>
              <div class="campo-lector__fila">
                <input id="ea-uid" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" value="${esc(a.nfcUid || '')}" placeholder="p. ej. 1399878112" aria-describedby="ayuda-ea-uid ea-uid-info">
                <button class="boton boton--secundario" type="button" id="ea-uid-leer">Leer pulsera</button>
              </div>
              <p class="campo__ayuda" id="ayuda-ea-uid">Pulsa «Leer pulsera» y acerca la pulsera al lector USB, o escribe el UID (decimal o hexadecimal).</p>
              <p class="lectura-uid" id="ea-uid-info" role="status">${a.nfcUid ? 'Guardada: ' + esc(a.nfcUid) + ' (hex ' + esc(MSDUid.aHex(a.nfcUid)) + ')' : 'Sin pulsera asignada todavía.'}</p>
            </div>
            <div class="ficha__acciones">
              <button class="boton boton--secundario" type="button" data-api-pulsera="${u.id}">Guardar pulsera</button>
              ${a.nfcUid ? `<button class="boton--texto es-peligro" type="button" data-api-liberar="${u.id}">Liberar pulsera</button>` : ''}
              ${a.qrUid ? `<button class="boton--texto" type="button" data-api-rotar="${u.id}">Renovar QR (móvil perdido)</button>` : ''}
            </div>
            <p class="campo__ayuda">${a.qrUid ? 'Carnet emitido · QR id ' + esc(a.qrUid) : 'Sin carnet todavía: se emite al dar de alta el abono.'}</p>
          </section>
          <section class="ficha__bloque" aria-labelledby="fb-4">
            <h4 id="fb-4"><span class="ficha__num">4</span> Gimnasio y clases</h4>
            ${htmlBloqueGimnasio(u.id, !!a.vigente)}
          </section>
          <section class="ficha__bloque ficha__bloque--ancho" aria-labelledby="fb-5">
            <h4 id="fb-5"><span class="ficha__num">5</span> Actividad y accesos</h4>
            <div id="ficha-actividad"><p class="tabla__sub">Cargando…</p></div>
          </section>
        </div>
        <details class="admin-plegable ficha__mas">
          <summary>Más opciones de la cuenta</summary>
          <div class="ficha__acciones">
            <button class="boton--texto" type="button" data-api-clave="${u.id}">Enviar enlace de contraseña</button>
            ${u.verificado ? '<span class="insignia insignia--plazas">Correo verificado</span>' : `<button class="boton--texto" type="button" data-api-verificar="${u.id}">Marcar correo verificado</button>`}
          </div>
          <div class="ficha__peligro"><span>Eliminar la cuenta anonimiza los datos, cancela reservas futuras y libera la pulsera. No se puede deshacer.</span><button class="boton boton--secundario es-peligro" type="button" data-api-eliminar="${u.id}">Eliminar la cuenta</button></div>
        </details>
      </form>`;
    abrirFicha();
    anotarNombresApi([u]);
    // Pulsera leída en el torno (modo alta) o en el buscador: ya rellena, solo falta «Guardar pulsera»
    if (uidPendiente && !a.nfcUid) {
      $('#ea-uid').value = uidPendiente; mostrarInfoUid(uidPendiente);
      const bp = $('[data-api-pulsera]'); if (bp) bp.classList.add('boton--destacado');
    }
    enfocarFicha(cont, op.foco);
    // Últimos accesos por el torno y recibos de esta persona
    MSDApi.get('/api/admin/usuarios/' + u.id).then((r) => {
      if (!$(`[data-editor-api="${u.id}"]`)) return;
      const c = $('#ficha-actividad');
      if (c) c.innerHTML = r.ok ? htmlAccesosFicha((r.datos.accesos || []).slice(0, 5)) : `<p class="tabla__sub">${esc(r.error)}</p>`;
      const cr = $('#ficha-recibos');
      if (cr) cr.innerHTML = r.ok ? htmlRecibosFicha((r.datos.usuario && r.datos.usuario.recibos) || []) : '';
    });
  }

  /* Recibos en la ficha (bloque Abono): estado de cada mensualidad y, si hay
     un impago, el aviso con el plazo y el contacto a mano. */
  function htmlRecibosFicha(lista) {
    if (!lista.length) return '<p class="tabla__sub">Sin recibos todavía: se emiten con el alta (tarjeta) y con cada renovación automática (domiciliación).</p>';
    const chip = { pendiente: 'insignia--aviso', pagado: 'insignia--plazas', devuelto: 'insignia--llena', anulado: 'insignia--neutra' };
    const met = { tarjeta: 'tarjeta', mostrador: 'mostrador', domiciliacion: 'domiciliación' };
    const dev = lista.find((x) => x.estado === 'devuelto');
    const aviso = dev
      ? `<p class="ficha__impago" role="alert">⚠ No ha pagado el recibo de ${esc(dev.periodo)}${dev.venceEn
        ? (Date.now() > dev.venceEn
          ? ': el plazo ha vencido y el torno ya NO le deja entrar.'
          : `: le quedan ${Math.max(0, Math.ceil((dev.venceEn - Date.now()) / 86400e3))} día(s) de plazo.`)
        : '.'} Contacta con la persona (teléfono y correo arriba) y, cuando pague, marca el recibo como pagado.</p>`
      : '';
    return aviso + `<ul class="ficha__lista" style="margin-top:8px">${lista.map((x) => `
      <li><span>${esc(x.periodo)} · ${Number(x.importe).toFixed(2).replace('.', ',')} € <small class="tabla__sub">${met[x.metodo] || esc(x.metodo)}</small> <span class="insignia ${chip[x.estado] || 'insignia--neutra'}">${esc(x.estado)}</span></span>
        <span>${x.estado !== 'pagado' && x.estado !== 'anulado' ? `<button class="boton--texto boton--compacto" type="button" data-recibo-estado="pagado" data-recibo="${esc(x.id)}">Marcar pagado</button>` : ''}${x.estado === 'pendiente' ? `<button class="boton--texto boton--compacto es-peligro" type="button" data-recibo-estado="devuelto" data-recibo="${esc(x.id)}">Devuelto</button>` : ''}</span></li>`).join('')}</ul>`;
  }

  /* Tarjeta roja del Inicio: los recibos devueltos, con el plazo general editable. */
  function pintarImpagos(d) {
    const c = $('#admin-impagos'); if (!c) return;
    const lista = (d && d.impagos) || [];
    const k = $('#kpi-impagos');
    if (k) { k.querySelector('strong').textContent = String(lista.length); k.classList.toggle('kpi--mal', lista.length > 0); }
    c.hidden = !lista.length;
    if (!lista.length) { c.innerHTML = ''; return; }
    c.innerHTML = `
      <div class="impagos__cabecera">
        <h2 class="admin-seccion__titulo impagos__titulo">Recibos devueltos por el banco: ${lista.length}</h2>
        <label class="impagos__margen" for="impago-margen">Días de plazo antes de cortar el torno
          <input type="number" id="impago-margen" min="0" max="90" value="${Number(d.margenDias) || 0}" inputmode="numeric">
          <button class="boton boton--secundario boton--compacto" type="button" id="impago-margen-guardar">Guardar</button>
        </label>
      </div>
      <ul class="impagos__lista">${lista.map((i) => `
        <li class="impago${i.bloqueado ? ' impago--bloqueado' : ''}">
          <div class="impago__quien"><strong>${esc(i.nombre)}</strong><small class="tabla__sub">${esc(i.telefono || 'sin teléfono')} · ${esc(i.email)}</small></div>
          <div class="impago__que"><span class="insignia insignia--llena">Recibo de ${esc(i.periodo)} · ${Number(i.importe).toFixed(2).replace('.', ',')} €</span>
            <small class="tabla__sub">${i.bloqueado ? 'Plazo vencido: el torno ya no le deja entrar' : 'Le quedan ' + Math.max(0, Math.ceil((i.venceEn - Date.now()) / 86400e3)) + ' día(s) de plazo'}</small></div>
          <div class="impago__acc">
            <button class="boton boton--secundario boton--compacto" type="button" data-abrir-ficha="${esc(i.usuarioId)}">Abrir ficha</button>
            <button class="boton--texto boton--compacto" type="button" data-recibo-estado="pagado" data-recibo="${esc(i.reciboId)}">Marcar pagado</button>
          </div>
        </li>`).join('')}</ul>`;
  }
  const errorEditorApi = (m) => { const e = $('#ea-error'); if (e) { e.textContent = m; e.hidden = !m; if (m) e.scrollIntoView({ block: 'nearest' }); } };
  async function trasAccionApi(r, mensajeOk) {
    if (!r.ok) { errorEditorApi(r.error); avisar(r.error, 'error'); return false; }
    if (mensajeOk) avisar(mensajeOk);
    await pintarAbonadosApi();
    return true;
  }

  // Submit de la ficha (datos personales + rol)
  document.addEventListener('submit', async (ev) => {
    const form = ev.target.closest('[data-editor-api]'); if (!form) return;
    ev.preventDefault();
    const id = form.dataset.editorApi; const u = porIdApi(id);
    errorEditorApi('');
    const boton = form.querySelector('button[type="submit"]');
    await conBloqueo(boton, async () => {
      const r = await MSDApi.patch(`/api/admin/usuarios/${id}`, { nombre: $('#ea-nombre').value.trim(), telefono: $('#ea-telefono').value.trim(), birthdate: $('#ea-nacimiento').value || undefined });
      if (!r.ok) { errorEditorApi(r.error); return; }
      const rol = $('#ea-rol').value;
      if (u && rol !== u.rol) { const rr = await MSDApi.patch(`/api/admin/usuarios/${id}/rol`, { rol }); if (!rr.ok) { errorEditorApi(rr.error); return; } }
      avisar('Datos guardados.');
      await pintarAbonadosApi();
      if (porIdApi(id)) abrirEditorApi(id, { foco: 'ficha-titulo' });
    });
  });

  // Clicks de la sección Socios (API). Cada acción bloquea su botón mientras dura (sin doble toque).
  document.addEventListener('click', async (ev) => {
    if (!MSDAuth.modoServidor) return;
    const b = ev.target.closest('[data-api-gestionar],[data-api-alta],[data-api-renovar],[data-api-baja],[data-api-alta-editor],[data-api-pulsera],[data-api-liberar],[data-api-rotar],[data-api-verificar],[data-api-clave],[data-api-eliminar],[data-api-ver-uid]');
    if (!b) return;
    const d = b.dataset;
    if (d.apiGestionar) { abrirEditorApi(d.apiGestionar, { foco: d.focoFicha || '' }); return; }
    if (d.apiVerUid) { const u = porIdApi(d.apiVerUid); if (u && u.abono) { avisar(`UID de ${u.nombre}: ${u.abono.nfcUid}`); } return; }
    await conBloqueo(b, async () => {
      if (d.apiAlta || d.apiRenovar) {
        const id = d.apiAlta || d.apiRenovar;
        const u = porIdApi(id);
        if (d.apiRenovar) {
          const ok = await confirmar('¿Renovar un mes?', `${u ? u.nombre : 'Este socio'}: el abono se alargará un mes desde su fecha de caducidad${u && u.abono && u.abono.hasta ? ' (' + diaLegible(u.abono.hasta) + ')' : ''}.`, 'Sí, renovar');
          if (!ok) return;
        }
        const r = await MSDApi.post(`/api/admin/usuarios/${id}/abono`, { meses: 1 });
        if (await trasAccionApi(r, null)) {
          const u2 = porIdApi(id);
          avisar(d.apiAlta ? 'Abono dado de alta (1 mes) y carnet emitido.' : `Abono renovado${u2 && u2.abono && u2.abono.hasta ? ' hasta el ' + diaLegible(u2.abono.hasta) : ' un mes'}.`);
          refrescarFichaAbierta();
        }
        return;
      }
      if (d.apiBaja) {
        const u = porIdApi(d.apiBaja);
        const ok = await confirmar('¿Dar de baja el abono?', `El torno dejará de aceptar el carnet de ${u ? u.nombre : 'esta persona'} desde ahora.`, 'Sí, dar de baja');
        if (!ok) return;
        if (await trasAccionApi(await MSDApi.post(`/api/admin/usuarios/${d.apiBaja}/abono/baja`), 'Abono dado de baja.')) refrescarFichaAbierta();
        return;
      }
      if (d.apiAltaEditor) {
        const meses = Math.max(1, Math.min(12, Number($('#ea-meses').value) || 1));
        const uid = $('#ea-uid').value.trim();
        const r = await MSDApi.post(`/api/admin/usuarios/${d.apiAltaEditor}/abono`, { meses, autoRenovar: $('#ea-auto').checked, nfcUid: uid || undefined });
        if (await trasAccionApi(r, `Abono activo ${meses} mes/es${uid ? ' y pulsera asignada' : ''}.`)) abrirEditorApi(d.apiAltaEditor, { foco: 'fb-3' });
        return;
      }
      if (d.apiPulsera) {
        const crudo = $('#ea-uid').value.trim();
        if (!crudo) { errorEditorApi('Pulsa «Leer pulsera» y acerca la pulsera al lector USB, o escribe el UID.'); $('#ea-uid').focus(); return; }
        const n = MSDUid.normalizar(crudo);
        if (!n.ok) { errorEditorApi(n.error); $('#ea-uid').focus(); return; }
        const r = await MSDApi.api('PUT', `/api/admin/usuarios/${d.apiPulsera}/carnet`, { nfcUid: n.principal, birthdate: $('#ea-nacimiento').value || undefined });
        if (await trasAccionApi(r, `Pulsera asignada (UID ${n.principal}${n.formato === 'hex' ? ', convertido de hexadecimal' : ''}).`)) {
          if (uidPendiente === n.principal || uidPendiente === crudo) { uidPendiente = ''; pintarUidPendiente(); }
          abrirEditorApi(d.apiPulsera, { foco: 'fb-4' });
          if (n.alternativas.length) avisar(`Si el torno no reconoce la pulsera, vuelve aquí y usa la alternativa ${n.alternativas[0]} (orden de bytes invertido).`);
        }
        return;
      }
      if (d.apiLiberar) {
        const u = porIdApi(d.apiLiberar);
        const ok = await confirmar('¿Liberar la pulsera?', `El torno dejará de aceptar la pulsera ···${u && u.abono && u.abono.nfcUid ? String(u.abono.nfcUid).slice(-4) : ''} de ${u ? u.nombre : 'esta persona'}. Podrás asignarle otra después.`, 'Sí, liberar');
        if (!ok) return;
        if (await trasAccionApi(await MSDApi.post(`/api/admin/usuarios/${d.apiLiberar}/carnet/liberar`), 'Pulsera liberada.')) abrirEditorApi(d.apiLiberar, { foco: 'ea-uid' });
        return;
      }
      if (d.apiRotar) {
        const ok = await confirmar('¿Renovar el QR?', 'Los códigos QR anteriores dejarán de valer (útil si ha perdido el móvil). El socio verá el nuevo al abrir su perfil.', 'Sí, renovar');
        if (!ok) return;
        if (await trasAccionApi(await MSDApi.post(`/api/admin/usuarios/${d.apiRotar}/carnet/rotar-qr`), 'QR renovado.')) refrescarFichaAbierta();
        return;
      }
      if (d.apiVerificar) { if (await trasAccionApi(await MSDApi.post(`/api/admin/usuarios/${d.apiVerificar}/verificar`), 'Correo marcado como verificado.')) refrescarFichaAbierta(); return; }
      if (d.apiClave) { await trasAccionApi(await MSDApi.post(`/api/admin/usuarios/${d.apiClave}/clave`, {}), 'Enlace de contraseña enviado por correo.'); return; }
      if (d.apiEliminar) {
        const u = porIdApi(d.apiEliminar);
        const ok = await confirmar('¿Eliminar esta cuenta?', `Se anonimizará la cuenta de ${u ? u.nombre : 'esta persona'}, se cancelarán sus reservas futuras y se liberará su pulsera. No se puede deshacer.`, 'Sí, eliminar');
        if (!ok) return;
        const r = await MSDApi.del(`/api/admin/usuarios/${d.apiEliminar}`);
        if (await trasAccionApi(r, 'Cuenta eliminada.')) cerrarFicha();
      }
    });
  });

  /* ---------- Lector USB de pulseras (tipo teclado) ----------
     Los lectores de escritorio "teclean" el UID y pulsan Enter. En el campo de
     pulsera: el Enter NO envía el formulario; normaliza y muestra qué se va a
     guardar (decimal para el torno) y la alternativa si era hexadecimal. En el
     campo del torno del panel: el Enter valida directamente en el servidor. */
  function mostrarInfoUid(crudo) {
    const info = $('#ea-uid-info'); if (!info) return;
    const n = MSDUid.normalizar(crudo);
    info.className = 'lectura-uid' + (!crudo ? '' : n.ok ? ' lectura-uid--ok' : ' lectura-uid--error');
    if (!crudo) { info.textContent = 'Acepta decimal o hexadecimal: se guarda siempre el decimal que lee el torno.'; return; }
    if (!n.ok) { info.textContent = '✕ ' + n.error; return; }
    info.textContent = `✓ Pulsera leída: ${n.principal} (hex ${MSDUid.aHex(n.principal)}) — pulsa «Guardar pulsera»`
      + (n.formato === 'hex' && n.alternativas.length ? ` · alternativa si el torno no la reconoce: ${n.alternativas[0]}` : '');
  }
  document.addEventListener('input', (ev) => { if (ev.target.id === 'ea-uid') mostrarInfoUid(ev.target.value.trim()); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    if (ev.target.id === 'ea-uid') {
      ev.preventDefault(); mostrarInfoUid(ev.target.value.trim());
      const b = $('[data-api-pulsera]'); if (b) { b.classList.add('boton--destacado'); b.focus(); }
    }
    if (ev.target.id === 'torno-manual') { ev.preventDefault(); const b = $('#torno-validar-manual'); if (b) b.click(); }
  });
  document.addEventListener('click', (ev) => {
    if (ev.target.id === 'ea-uid-leer') {
      const c = $('#ea-uid'); if (!c) return;
      c.value = ''; c.focus(); mostrarInfoUid('');
      const z = $('#campo-lector-ea'); if (z) z.classList.add('campo-lector--escuchando');   // «escuchando» (coral) hasta que el campo pierda el foco
      avisar('Acerca la pulsera al lector USB: el número aparecerá en el campo.');
    }
    if (ev.target.closest('[data-api-pulsera]')) { const bp = ev.target.closest('[data-api-pulsera]'); bp.classList.remove('boton--destacado'); }
  });
  document.addEventListener('focusout', (ev) => {
    if (ev.target.id === 'ea-uid') { const z = $('#campo-lector-ea'); if (z) z.classList.remove('campo-lector--escuchando'); }
  });

  // Crear usuario desde recepción (API): sin contraseña → invitación por correo; después se abre su ficha
  $('#form-crear-usuario').addEventListener('submit', async (ev) => {
    if (!MSDAuth.modoServidor) return;    // el handler legado se encarga en modo local
    ev.stopImmediatePropagation(); ev.preventDefault();
    const nombre = $('#nuevo-nombre').value.trim(), email = $('#nuevo-email').value.trim(), claveTemporal = $('#nuevo-clave').value;
    errorEn('nuevo-nombre', nombre.length < 3 ? 'Escribe el nombre y apellidos (mínimo 3 letras).' : '');
    errorEn('nuevo-email', /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? '' : 'Escribe un correo válido.');
    if (nombre.length < 3 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { $(nombre.length < 3 ? '#nuevo-nombre' : '#nuevo-email').focus(); return; }
    const boton = ev.target.querySelector('button[type="submit"]');
    await conBloqueo(boton, async () => {
      const r = await MSDApi.post('/api/admin/usuarios', { nombre, email, telefono: $('#nuevo-telefono').value, rol: $('#nuevo-rol').value, claveTemporal: claveTemporal || undefined });
      if (!r.ok) {
        if (r.campo && $('#nuevo-' + r.campo)) errorEn('nuevo-' + r.campo, r.error); else avisar(r.error, 'error');
        return;
      }
      avisar(claveTemporal ? `Cuenta de ${nombre} creada con contraseña temporal.` : `Cuenta de ${nombre} creada: le llegará un correo para elegir contraseña.`);
      ev.target.reset();
      $('#abonados-crear').open = false;
      busquedaAbonados = ''; filtroAbonoApi = ''; $('#buscar-abonado').value = ''; $('#filtro-abono-api').value = '';
      await pintarAbonadosApi();
      const nuevo = r.datos && r.datos.usuario;
      if (nuevo) {
        if (!porIdApi(nuevo.id)) usuariosApi.push(nuevo);
        abrirEditorApi(nuevo.id, { foco: 'ea-meses' });   // paso 2: abono
      }
    });
  }, true);   // captura: va antes que el handler legado

  /* ---------- Recibos e impagos (modo servidor) ---------- */
  // Marcar un recibo (desde la tarjeta de Inicio o desde la ficha del socio)
  document.addEventListener('click', async (ev) => {
    if (!MSDAuth.modoServidor) return;
    const b = ev.target.closest('[data-recibo-estado]'); if (!b) return;
    const estado = b.dataset.reciboEstado;
    await conBloqueo(b, async () => {
      if (estado === 'devuelto') {
        const ok = await confirmar('¿Marcar el recibo como devuelto?', 'Empieza el plazo para pagar: el panel lo mostrará en rojo y, si el plazo vence, el torno no le dejará entrar.', 'Sí, es un impago');
        if (!ok) return;
      }
      const r = await MSDApi.post(`/api/admin/recibos/${b.dataset.recibo}/estado`, { estado });
      if (!r.ok) { avisar(r.error, 'error'); return; }
      avisar(estado === 'pagado' ? 'Recibo marcado como pagado.' : `Recibo marcado como ${estado}.`);
      // refresca lo que esté a la vista: la lista cacheada, la tarjeta de Inicio y la ficha
      await pintarAbonadosApi();
      if (seccionActual === 'panel') refrescarInicioServidor();
      refrescarFichaAbierta();
    });
  });
  // Plazo general del impago (días hasta cortar el torno)
  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('#impago-margen-guardar'); if (!b) return;
    const dias = Math.max(0, Math.min(90, Number($('#impago-margen').value) || 0));
    await conBloqueo(b, async () => {
      const r = await MSDApi.patch('/api/admin/ajustes/impagos', { margenDias: dias });
      if (!r.ok) { avisar(r.error, 'error'); return; }
      avisar(`Plazo guardado: ${dias} día(s) desde el impago hasta que el torno corta la entrada.`);
      refrescarInicioServidor();
    });
  });
  // La casilla «Renovación automática» de la ficha se aplica al momento si el abono está en vigor
  document.addEventListener('change', async (ev) => {
    if (!MSDAuth.modoServidor || ev.target.id !== 'ea-auto') return;
    const f = ev.target.closest('[data-editor-api]'); if (!f) return;
    const u = porIdApi(f.dataset.editorApi);
    if (!u || !u.abono || !u.abono.vigente) return;   // sin abono en vigor, se aplica al dar el alta
    const marcado = ev.target.checked;
    const r = await MSDApi.patch(`/api/admin/usuarios/${f.dataset.editorApi}/abono`, { autoRenovar: marcado });
    if (!r.ok) { avisar(r.error, 'error'); ev.target.checked = !marcado; return; }
    avisar(marcado ? 'Renovación automática activada: cada mes saldrá el recibo domiciliado.' : 'Renovación automática desactivada: el abono caducará si no renueva en recepción.');
    await pintarAbonadosApi();
  });

  /* ---------- Datos de prueba (fase de pruebas): sembrar y borrar ---------- */
  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('#pruebas-sembrar, #pruebas-limpiar'); if (!b) return;
    if (!MSDAuth.modoServidor) { avisar('Los datos de prueba necesitan el modo servidor (base de datos).', 'error'); return; }
    const sembrarloYo = b.id === 'pruebas-sembrar';
    await conBloqueo(b, async () => {
      const ok = await confirmar(
        sembrarloYo ? '¿Sembrar los datos de prueba?' : '¿Borrar los datos de prueba?',
        sembrarloYo
          ? 'Se crearán 14 vecinos @prueba.local con abonos, gimnasio, reservas, clases y un impago de muestra. Los verá todo el que entre en la web hasta que los borres.'
          : 'Se eliminarán todos los vecinos @prueba.local con sus abonos, recibos, reservas, horas de gimnasio y clases. Los datos reales no se tocan.',
        sembrarloYo ? 'Sí, sembrar' : 'Sí, borrar');
      if (!ok) return;
      const r = await MSDApi.post(sembrarloYo ? '/api/admin/pruebas/sembrar' : '/api/admin/pruebas/limpiar');
      if (!r.ok) { avisar(r.error, 'error'); return; }
      const d = r.datos;
      avisar(sembrarloYo
        ? `Hecho: ${d.usuarios} vecinos nuevos, ${d.abonos} abonos, ${d.reservas} reservas, ${d.gimnasio} en gimnasio, ${d.clases} en clases y ${d.impagos} impago de muestra.`
        : `Hecho: ${d.usuariosBorrados} vecinos de prueba borrados con todo lo suyo.`);
      MSDAuth.recargar();
      irASeccion(seccionActual);
    });
  });

  /* ---------- Torno (API): validar en servidor + modo alta + estado ---------- */
  let modoAltaTimer = null;
  async function refrescarEstadoTorno() {
    const est = await MSDApi.get('/api/admin/torno/estado');
    if (est.ok) pintarEstadoTorno(est.datos);
  }
  async function pintarTornoApi() {
    // el selector de «simular» no pinta nada en producción: se valida lo que lee el lector
    const sel = $('#torno-abonado');
    if (sel) { sel.innerHTML = '<option value="">(modo servidor: valida la lectura real)</option>'; const campo = sel.closest('.campo'); if (campo) campo.hidden = true; }
    const resumen = $('.torno-extra summary'); if (resumen) resumen.textContent = 'Cámara (QR del móvil)';
    const bloque = $('#torno-api-bloque'); if (bloque) bloque.hidden = false;
    refrescarEstadoTorno();
    if (!camaraFlujo) { const c = $('#torno-manual'); if (c) c.focus({ preventScroll: true }); }
    await pintarAccesosApi();
  }
  async function pintarAccesosApi() {
    const r = await MSDApi.get('/api/admin/accesos');
    const cont = $('#admin-accesos');
    if (!r.ok) { cont.innerHTML = `<div class="aviso-vacio aviso-vacio--error" role="alert"><strong>No se han podido cargar los accesos</strong>${esc(r.error)}</div>`; return; }
    const accesos = (r.datos.accesos || []).slice(0, 12);
    if (!accesos.length) { cont.innerHTML = '<div class="aviso-vacio"><strong>Sin accesos registrados</strong>Cuando alguien pase por el torno aparecerá aquí.</div>'; return; }
    cont.innerHTML = `<div class="tabla-envoltura" tabindex="0" role="region" aria-label="Últimos accesos"><table class="tabla">
      <thead><tr><th scope="col">Momento</th><th scope="col">Persona</th><th scope="col">Sentido</th><th scope="col">Método</th><th scope="col">Resultado</th></tr></thead>
      <tbody>${accesos.map((a) => `<tr class="${a.resultado === 'ok' ? '' : 'tabla__fila--mal'}">
        <td data-etiqueta="Momento">${esc(fmtMomento.format(new Date(a.ts)))}${a.origen === 'panel' ? ' <small class="tabla__sub">(panel)</small>' : ''}</td>
        <td data-etiqueta="Persona">${esc(a.nombre || 'Desconocido')}${a.usuarioId ? ` <button class="boton--texto boton--compacto" type="button" data-abrir-ficha="${esc(a.usuarioId)}">Abrir ficha</button>` : (a.raw ? `<br><span class="tabla__sub mono">${esc(a.raw)}</span>` : '')}</td>
        <td data-etiqueta="Sentido">${a.direccion === 'salida' ? '<span class="insignia insignia--neutra">Salida</span>' : '<span class="insignia insignia--plazas">Entrada</span>'}</td>
        <td data-etiqueta="Método">${a.metodo === 'qr' ? 'QR' : 'Pulsera NFC'}</td>
        <td data-etiqueta="Resultado">${a.resultado === 'ok' ? `<span class="insignia insignia--plazas">${icono('i-check', 13)} Permitido</span>${(a.avisos || []).length ? ' <small class="tabla__sub">' + esc(a.avisos.join(' · ')) + '</small>' : ''}` : `<span class="insignia insignia--llena">${icono('i-x', 13)} ${esc(a.motivo)}</span>`}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }
  async function validarEnServidor(lectura) {
    const r = await MSDApi.post('/api/admin/torno/validar', { lectura, direccion: direccionTorno() });
    if (!r.ok) { avisar(r.error, 'error'); return; }
    const res = r.datos;
    reaccionTorno({ resultado: res.resultado, motivo: res.motivo, direccion: res.direccion, usuario: res.usuario || null, avisos: res.avisos || [] });
    const c = $('#torno-manual'); if (c) { c.value = ''; c.focus(); }   // listo para la siguiente lectura
  }
  async function modoAltaTick() {
    const cont = $('#torno-api-alta'); if (!cont || cont.hidden) return;
    const r = await MSDApi.get('/api/admin/torno/lecturas-desconocidas');
    const lista = r.ok ? r.datos.lecturas : [];
    $('#torno-api-alta-lista').innerHTML = lista.length
      ? `<ul class="lista-accesos">${lista.map((l) => `<li><span>${icono('i-nfc', 14)} <strong class="mono">···${esc(String(l.raw).slice(-4))}</strong> <span class="tabla__sub">(${esc(l.raw)}) · ${esc(fmtMomento.format(new Date(l.ts)))} · ${l.direccion}</span></span> <button class="boton boton--secundario boton--compacto" type="button" data-api-asignar-uid="${esc(l.raw)}">Asignar a un socio…</button></li>`).join('')}</ul>`
      : '<p class="paso__ayuda">Escuchando… pasa la pulsera nueva por el lector del torno: aparecerá aquí en unos segundos.</p>';
  }

  /* Abrir la ficha de alguien desde el torno o la tabla de accesos (en cualquier modo) */
  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-abrir-ficha]'); if (!b) return;
    const id = b.dataset.abrirFicha;
    busquedaAbonados = ''; filtroAbonoApi = '';
    const bb = $('#buscar-abonado'); if (bb) bb.value = ''; const fs = $('#filtro-abono-api'); if (fs) fs.value = '';
    activarSeccion('abonados');
    if (MSDAuth.modoServidor) {
      await pintarAbonadosApi();
      if (!porIdApi(id)) { const r = await MSDApi.get('/api/admin/usuarios/' + id); if (r.ok && r.datos.usuario) usuariosApi.push(r.datos.usuario); }
      abrirEditorApi(id);
    } else { pintarAbonados(); abrirEditorUsuario(id); }
  });

  if (typeof MSDAuth !== 'undefined') {
    MSDAuth.listo.then(() => {
      if (!MSDAuth.modoServidor) return;
      // Sustituye las secciones por su versión API
      pintores.abonados = pintarAbonadosApi;
      pintores.torno = pintarTornoApi;
      pintores.gimnasio = async () => { if (!usuariosApi.length) await cargarUsuariosApi(true); pintarGimnasio(); };
      // Torno: validación real en servidor; los botones "simular" dejan de tener sentido
      const manual = $('#torno-validar-manual');
      if (manual) { const nuevo = manual.cloneNode(true); manual.replaceWith(nuevo); nuevo.addEventListener('click', () => { const t = $('#torno-manual').value.trim(); if (!t) { avisar('Pasa la pulsera por el lector o pega el código del QR.', 'error'); $('#torno-manual').focus(); return; } validarEnServidor(t); }); }
      ['torno-leer-nfc', 'torno-leer-qr'].forEach((id) => { const b = $('#' + id); if (b) b.hidden = true; });
      // Modo alta de pulseras (el bloque y el estado ya están en admin.html)
      const toggle = $('#torno-api-alta-toggle');
      if (toggle) toggle.addEventListener('click', () => {
        const c = $('#torno-api-alta'); c.hidden = !c.hidden;
        toggle.setAttribute('aria-pressed', String(!c.hidden));
        const bloque = $('#torno-api-bloque'); if (bloque) bloque.dataset.activo = String(!c.hidden);
        clearInterval(modoAltaTimer);
        if (!c.hidden) { modoAltaTick(); modoAltaTimer = setInterval(modoAltaTick, 3000); }
      });
      document.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-api-asignar-uid]'); if (!b) return;
        uidPendiente = b.dataset.apiAsignarUid;
        navigator.clipboard && navigator.clipboard.writeText(uidPendiente).catch(() => {});
        pintarUidPendiente();
        busquedaAbonados = ''; filtroAbonoApi = ''; $('#buscar-abonado').value = ''; $('#filtro-abono-api').value = '';
        cerrarFicha();
        activarSeccion('abonados');
        pintarAbonadosApi();
        $('#buscar-abonado').focus();
        avisar(`Pulsera ···${uidPendiente.slice(-4)} lista: busca al socio y abre su ficha.`);
      });
      // cámara: en modo servidor el resultado del QR se valida en servidor
      window.__msdValidarLectura = validarEnServidor;
    });
  }

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* opcional */ });
  }
})();
