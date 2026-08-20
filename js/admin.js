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
    aviso.className = `aviso${tipo === 'error' ? ' aviso--error' : ' aviso--ok'}`;
    aviso.innerHTML = `${icono(tipo === 'error' ? 'i-info' : 'i-check', 18)}<span>${esc(mensaje)}</span>`;
    contAvisos.appendChild(aviso);
    setTimeout(() => aviso.remove(), 4200);
  }

  const dlgFondo = $('#dialogo-fondo');
  let dlgResolver = null;
  let dlgAbiertoEn = 0;
  function confirmar(titulo, texto, textoAceptar) {
    return new Promise((resolver) => {
      dlgResolver = resolver;
      dlgAbiertoEn = performance.now();
      $('#dialogo-titulo').textContent = titulo;
      $('#dialogo-texto').textContent = texto;
      $('#dialogo-aceptar').textContent = textoAceptar || 'Sí, continuar';
      dlgFondo.hidden = false;
      $('#dialogo-cancelar').focus();
    });
  }
  function cerrarDialogo(res) {
    if (!dlgResolver) return;
    dlgFondo.hidden = true;
    const r = dlgResolver;
    dlgResolver = null;
    r(res);
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
  const nombreDe = (usuarioId) => {
    const u = usuarioId && MSDAuth.buscarPorId(usuarioId);
    return u ? u.nombre : 'Vecino/a';
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

    $('#admin-kpis').innerHTML = [
      [abonados.length, 'Abonados en vigor'],
      [proximas.length, 'Reservas próximas'],
      [`${llenas.length} / ${CLASES.length}`, 'Clases completas'],
      [enCola, 'Personas en cola'],
      [accesosHoy.length, 'Accesos hoy por el torno'],
      [eur.format(ingresos), 'Ingresos estimados del mes']
    ].map(([v, t]) => `<div class="kpi"><strong>${esc(String(v))}</strong><span>${esc(t)}</span></div>`).join('');

    $('#admin-auto-resumen').innerHTML = htmlAutomatizaciones(5);
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

  function pintarAbonados() {
    const texto = busquedaAbonados.trim().toLowerCase();
    const lista = vecinos().filter((u) =>
      !texto || u.nombre.toLowerCase().includes(texto) || u.email.toLowerCase().includes(texto));
    const cont = $('#admin-abonados');

    const controles = `
      <div class="admin-filtros">
        <label class="admin-filtros__campo admin-filtros__campo--ancho">
          <span>Buscar vecino</span>
          <input type="search" id="buscar-abonado" value="${esc(busquedaAbonados)}"
                 placeholder="Nombre o correo…" autocomplete="off">
        </label>
      </div>`;

    if (!lista.length) {
      cont.innerHTML = controles + '<div class="aviso-vacio"><strong>Sin resultados</strong>Prueba con otro nombre o correo.</div>';
      return;
    }
    cont.innerHTML = controles + `
      <div class="tabla-envoltura" tabindex="0" role="region" aria-label="Tabla desplazable">
      <table class="tabla">
        <thead><tr>
          <th scope="col">Vecino/a</th><th scope="col">Contacto</th><th scope="col">Abono</th>
          <th scope="col">Carnet</th><th scope="col">Renovación</th><th scope="col"><span class="visualmente-oculto">Acciones</span></th>
        </tr></thead>
        <tbody>
          ${lista.map((u) => {
            const estado = !u.abono
              ? '<span class="insignia insignia--pocas">Sin abono</span>'
              : (abonoVigente(u)
                ? `<span class="insignia insignia--plazas">Hasta ${esc(u.abono.hasta)}</span>`
                : (u.abono.activo
                  ? `<span class="insignia insignia--llena">Caducado ${esc(u.abono.hasta)}</span>`
                  : '<span class="insignia insignia--llena">De baja</span>'));
            return `<tr>
              <td data-etiqueta="Vecino/a"><strong>${esc(u.nombre)}</strong></td>
              <td data-etiqueta="Contacto">${esc(u.email)}<br><span style="color:var(--tinta-suave)">${esc(u.telefono || '—')}</span></td>
              <td data-etiqueta="Abono">${estado}</td>
              <td data-etiqueta="Carnet">${u.abono ? esc(u.abono.nfcUid || u.abono.nfcId || '—') : '—'}</td>
              <td data-etiqueta="Renovación">${u.abono && u.abono.activo ? (u.abono.autoRenovar ? 'Automática' : 'Manual') : '—'}</td>
              <td data-etiqueta="Acciones">
                ${u.abono && u.abono.activo
                  ? `<button class="boton--texto" type="button" data-renovar="${esc(u.id)}" style="color:var(--verde)">Renovar</button>
                     <button class="boton--texto" type="button" data-baja-abono="${esc(u.id)}">Baja</button>`
                  : `<button class="boton--texto" type="button" data-activar="${esc(u.id)}" style="color:var(--verde)">Activar abono</button>`}
                <button class="boton--texto" type="button" data-gestionar="${esc(u.id)}" style="color:var(--anil)">Gestionar</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      </div>`;
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
      estado.innerHTML = `${esc(sentido)} permitida<small>${esc(res.usuario.nombre)} · ${esc(res.motivo)}</small>`;
    } else {
      torno.classList.add('torno--mal');
      estado.innerHTML = `${esc(sentido)} denegada<small>${esc(res.usuario ? res.usuario.nombre + ' · ' : '')}${esc(res.motivo)}</small>`;
    }
    tornoTemporizador = setTimeout(() => {
      torno.classList.remove('torno--ok', 'torno--mal');
      estado.innerHTML = 'En espera<small>Acerca una pulsera o un QR</small>';
    }, 4000);
    marcarAccesosVistos(); // lo generó este panel: no volver a avisarlo por SSE
    pintarAccesos();
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
          ${accesos.map((a) => `<tr>
            <td data-etiqueta="Momento">${esc(fmtMomento.format(new Date(a.ts)))}</td>
            <td data-etiqueta="Persona">${esc(a.usuarioId ? nombreDe(a.usuarioId) : 'Desconocido')}${a.usuarioId ? '' : (a.raw ? `<br><span style="color:var(--tinta-suave)">${esc(a.raw)}</span>` : '')}</td>
            <td data-etiqueta="Sentido">${a.direccion === 'salida'
              ? '<span class="insignia">Salida</span>'
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
    $('#admin-tarifas').innerHTML = `
      <h3 class="etiqueta-grupo" style="margin-top:6px">Alquiler de instalaciones</h3>
      <div class="tabla-envoltura" tabindex="0" role="region" aria-label="Tabla de tarifas">
      <table class="tabla"><thead><tr>
        <th scope="col">Instalación</th><th scope="col">Precio (€)</th><th scope="col">Suplemento de luz (€)</th>
      </tr></thead><tbody>
        ${INSTALACIONES.map((i) => `<tr>
          <td data-etiqueta="Instalación">${esc(i.nombre)} <span style="color:var(--tinta-suave)">/ ${esc(i.unidad)}</span></td>
          <td data-etiqueta="Precio"><input class="tarifa-campo" type="number" min="0" step="0.5" id="tarifa-precio-${i.id}" value="${i.precio}" aria-label="Precio de ${esc(i.nombre)}"></td>
          <td data-etiqueta="Luz">${i.exterior
            ? `<input class="tarifa-campo" type="number" min="0" step="0.5" id="tarifa-luz-${i.id}" value="${i.suplementoLuz}" aria-label="Suplemento de luz de ${esc(i.nombre)}">`
            : '—'}</td>
        </tr>`).join('')}
      </tbody></table></div>

      <h3 class="etiqueta-grupo" style="margin-top:20px">Cuotas mensuales de actividades</h3>
      <div class="tabla-envoltura" tabindex="0" role="region" aria-label="Tabla de cuotas">
      <table class="tabla"><thead><tr>
        <th scope="col">Actividad</th><th scope="col">Cuota (€/mes)</th>
      </tr></thead><tbody>
        ${CLASES.map((c) => `<tr>
          <td data-etiqueta="Actividad">${esc(c.nombre)}</td>
          <td data-etiqueta="Cuota"><input class="tarifa-campo" type="number" min="0" step="0.5" id="tarifa-clase-${c.id}" value="${c.precioMes}" aria-label="Cuota mensual de ${esc(c.nombre)}"></td>
        </tr>`).join('')}
      </tbody></table></div>

      <h3 class="etiqueta-grupo" style="margin-top:20px">Abono del gimnasio</h3>
      <label class="admin-filtros__campo"><span>Cuota mensual (€)</span>
        <input class="tarifa-campo" type="number" min="0" step="0.5" id="tarifa-abono" value="${MSDAuth.PRECIO_ABONO}">
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

  function abrirEditorUsuario(id) {
    const u = MSDAuth.buscarPorId(id);
    if (!u) return;
    const cont = $('#editor-usuario');
    cont.hidden = false;
    cont.innerHTML = `
      <form class="formulario" data-editor-usuario="${esc(u.id)}" aria-label="Editar a ${esc(u.nombre)}">
        <h3 class="etiqueta-grupo">Editando a ${esc(u.nombre)}</h3>
        <div class="admin-filtros">
          <label class="admin-filtros__campo admin-filtros__campo--ancho"><span>Nombre</span>
            <input id="editor-nombre" type="text" value="${esc(u.nombre)}" minlength="3"></label>
          <label class="admin-filtros__campo"><span>Teléfono</span>
            <input id="editor-telefono" type="tel" value="${esc(u.telefono || '')}"></label>
          <label class="admin-filtros__campo"><span>Rol</span>
            <select id="editor-rol">
              <option value="vecino"${u.rol === 'vecino' ? ' selected' : ''}>Vecino/a</option><option value="monitor"${u.rol === 'monitor' ? ' selected' : ''}>Monitor/a</option>
              <option value="admin"${u.rol === 'admin' ? ' selected' : ''}>Administración</option>
            </select></label>
          <label class="admin-filtros__campo"><span>Nueva contraseña (opcional, mín. 8)</span>
            <input id="editor-clave" type="text" value="" autocomplete="off"></label>
        </div>
        ${u.abono ? `
        <h3 class="etiqueta-grupo" style="margin-top:18px">Carnet y acceso por el torno</h3>
        <div class="admin-filtros">
          <label class="admin-filtros__campo"><span>UID de la tarjeta/pulsera (decimal)</span>
            <input id="editor-uid" type="text" inputmode="numeric" value="${esc(u.abono.nfcUid || '')}" placeholder="p. ej. 1399878112"></label>
          <label class="admin-filtros__campo"><span>Fecha de nacimiento (edad mín. ${MSDAuth.EDAD_MINIMA})</span>
            <input id="editor-nacimiento" type="date" value="${esc(u.birthdate || '')}"></label>
          <p class="campo__ayuda" style="align-self:end">Para capturar el UID real, pasa la tarjeta por el lector en «modo alta» y cópialo aquí.</p>
        </div>` : ''}
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px">
          <button class="boton boton--primario" type="submit">Guardar cambios</button>
          <button class="boton boton--secundario" type="button" data-cerrar-editor>Cerrar</button>
          <button class="boton--texto" type="button" data-eliminar-usuario="${esc(u.id)}">Eliminar la cuenta</button>
        </div>
      </form>`;
    cont.scrollIntoView({ block: 'nearest' });
    $('#editor-nombre').focus();
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
    $('#editor-usuario').hidden = true;
    pintarAbonados();
    pintarSelectorTorno();
  });

  document.addEventListener('click', async (ev) => {
    const gestionar = ev.target.closest('[data-gestionar]');
    if (gestionar) { abrirEditorUsuario(gestionar.dataset.gestionar); return; }
    if (ev.target.closest('[data-cerrar-editor]')) { $('#editor-usuario').hidden = true; return; }
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
      $('#editor-usuario').hidden = true;
      pintarAbonados();
    }
  });

  $('#form-crear-usuario').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const nombre = $('#nuevo-nombre').value.trim();
    const email = $('#nuevo-email').value.trim();
    const clave = $('#nuevo-clave').value;
    if (nombre.length < 3 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || clave.length < 8) {
      avisar('Revisa nombre, correo y contraseña (mínimo 8 caracteres).', 'error');
      return;
    }
    const res = await MSDAuth.adminCrearUsuario({
      nombre, email, clave,
      telefono: $('#nuevo-telefono').value,
      rol: $('#nuevo-rol').value
    });
    if (res.error) { avisar(res.error, 'error'); return; }
    avisar(`Cuenta de ${nombre} creada.`);
    ev.target.reset();
    pintarAbonados();
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
    const abonados = MSDAuth.usuarios().filter(abonoVigente).sort((a, b) => a.nombre.localeCompare(b.nombre));
    gimAbonadosMap = {};
    $('#gim-abonados').innerHTML = abonados.map((u) => {
      const etq = `${u.nombre} (${u.email})`;
      gimAbonadosMap[etq] = u.id;
      return `<option value="${esc(etq)}"></option>`;
    }).join('');

    // Select de franjas con su ocupación a la vista.
    $('#gim-franja').innerHTML = cfg.franjas.map((f) => {
      const o = MSDGimnasio.ocupacion(f);
      const est = o.asignados >= o.capacidad ? `LLENA${o.espera ? ' · ' + o.espera + ' en cola' : ''}` : `${o.asignados}/${o.capacidad}`;
      return `<option value="${f}">${esc(MSDGimnasio.etiqueta(f))} — ${est}</option>`;
    }).join('');

    // Rejilla de franjas con asignados y lista de espera.
    const filaGente = (g) => `
      <li class="gim-persona">
        <span class="gim-persona__nombre">${g.posicion ? `<span class="gim-cola-num">${g.posicion}º</span> ` : ''}${esc(nombreDe(g.usuarioId))}${g.nota ? ` <span class="gim-persona__nota" title="${esc(g.nota)}" aria-label="Nota: ${esc(g.nota)}">📝</span>` : ''}</span>
        <span class="gim-persona__acc">
          <button class="boton-mini" type="button" data-gim-mover="${g.id}">Mover</button>
          <button class="boton-mini boton-mini--rojo" type="button" data-gim-quitar="${g.id}" aria-label="Quitar del gimnasio">✕</button>
        </span>
      </li>`;
    $('#gimnasio-franjas').innerHTML = cfg.franjas.map((f) => {
      const o = MSDGimnasio.ocupacion(f);
      const gente = MSDGimnasio.deFranja(f);
      const asignados = gente.filter((g) => g.estado === 'asignado');
      const espera = gente.filter((g) => g.estado === 'espera');
      const pct = Math.min(100, Math.round((o.asignados / o.capacidad) * 100));
      const llena = o.asignados >= o.capacidad;
      return `
        <article class="gim-franja${llena ? ' gim-franja--llena' : ''}">
          <header class="gim-franja__cima">
            <strong>${esc(MSDGimnasio.etiqueta(f))}</strong>
            <span class="insignia ${llena ? 'insignia--llena' : 'insignia--plazas'}">${o.asignados}/${o.capacidad}${o.espera ? ` · ${o.espera} en cola` : ''}</span>
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
    const usuarioId = gimAbonadosMap[$('#gim-socio').value.trim()];
    const franja = $('#gim-franja').value;
    const nota = $('#gim-nota').value.trim();
    if (!usuarioId) { mostrar('Elige un socio de la lista (debe tener abono en vigor).'); $('#gim-socio').focus(); return; }
    const u = MSDAuth.buscarPorId(usuarioId);
    if (!u || !abonoVigente(u)) { mostrar('Ese socio no tiene abono en vigor.'); return; }
    if (!franja) { mostrar('Elige una hora.'); return; }
    const res = MSDGimnasio.apuntar(usuarioId, franja, nota);
    if (res.error) { mostrar(res.error); return; }
    $('#gim-socio').value = ''; $('#gim-nota').value = '';
    pintarGimnasio();
    if (typeof avisar === 'function') {
      avisar(res.estado === 'espera'
        ? `${u.nombre} queda en lista de espera de las ${franja}.`
        : `${u.nombre} apuntado al gimnasio a las ${MSDGimnasio.etiqueta(franja)}.`);
    }
  });

  // Mover (despliega un selector en línea) / Quitar
  document.addEventListener('click', (ev) => {
    const mover = ev.target.closest('[data-gim-mover]');
    if (mover) {
      const acc = mover.closest('.gim-persona__acc');
      const id = mover.dataset.gimMover;
      acc.innerHTML = `<select class="gim-mover-sel" data-gim-mover-sel="${id}" aria-label="Mover a otra hora">
        <option value="">Mover a…</option>
        ${MSDGimnasio.config().franjas.map((f) => `<option value="${f}">${esc(MSDGimnasio.etiqueta(f))}</option>`).join('')}
      </select>`;
      const sel = acc.querySelector('select'); if (sel) sel.focus();
      return;
    }
    const quitar = ev.target.closest('[data-gim-quitar]');
    if (quitar) { MSDGimnasio.quitar(quitar.dataset.gimQuitar); pintarGimnasio(); }
  });
  document.addEventListener('change', (ev) => {
    const sel = ev.target.closest('[data-gim-mover-sel]');
    if (sel && sel.value) { MSDGimnasio.mover(sel.dataset.gimMoverSel, sel.value); pintarGimnasio(); }
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

  function irASeccion(nombre) {
    if (nombre !== 'torno') pararCamara(); // no dejar la cámara encendida en segundo plano
    seccionActual = nombre;
    $$('#admin-menu button').forEach((b) => {
      if (b.dataset.seccion === nombre) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });
    $$('.admin-seccion').forEach((s) => { s.hidden = s.id !== `seccion-${nombre}`; });
    pintores[nombre]();
  }

  $('#admin-menu').addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-seccion]');
    if (boton) irASeccion(boton.dataset.seccion);
  });

  /* Filtros y búsqueda (los controles se repintan con cada sección) */
  document.addEventListener('input', (ev) => {
    if (ev.target.id === 'buscar-abonado') {
      busquedaAbonados = ev.target.value;
      const posicion = ev.target.selectionStart;
      pintarAbonados();
      const campo = $('#buscar-abonado');
      campo.focus();
      campo.setSelectionRange(posicion, posicion);
    }
  });
  document.addEventListener('change', (ev) => {
    if (ev.target.id === 'filtro-reservas-inst') {
      filtroReservasInst = ev.target.value;
      pintarReservas();
    } else if (ev.target.id === 'filtro-reservas-proximas') {
      soloProximas = ev.target.checked;
      pintarReservas();
    }
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
      pintarReservas();
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
      return;
    }

    if (el.dataset.activar) {
      MSDAuth.activarAbono(el.dataset.activar, true);
      avisar('Abono activado y carnet emitido.');
      pintarAbonados();
      return;
    }
    if (el.dataset.renovar) {
      MSDAuth.renovarAbono(el.dataset.renovar, true);
      avisar('Abono renovado un mes.');
      pintarAbonados();
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
          Promise.resolve(MSDAuth.validarAccesoQr(qr.data, direccionTorno())).then(reaccionTorno);
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
    if (mensaje) {
      campo.setAttribute('aria-invalid', 'true');
      error.textContent = mensaje;
      error.hidden = false;
    } else {
      campo.removeAttribute('aria-invalid');
      error.hidden = true;
    }
  }

  function mostrarApp(u) {
    $('#admin-login').hidden = true;
    $('#admin-app').hidden = false;
    $('#admin-salir').hidden = false;
    $('#admin-hola').textContent = `Sesión de ${u.nombre} · ${u.email}`;
    irASeccion(seccionActual);
  }

  function mostrarLogin() {
    $('#admin-login').hidden = false;
    $('#admin-app').hidden = true;
    $('#admin-salir').hidden = true;
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
      const campo = res.campo === 'email' ? 'admin-email' : 'admin-clave';
      errorEn(campo, res.error);
      $(`#${campo}`).focus();
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
      if (enApp) irASeccion(seccionActual);
    });
  });

  // Cerrar el aviso en vivo a mano
  const cerrarVivo = $('#acceso-vivo-cerrar');
  if (cerrarVivo) cerrarVivo.addEventListener('click', () => { $('#acceso-vivo').hidden = true; });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* opcional */ });
  }
})();
