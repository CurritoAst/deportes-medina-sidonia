/* ==========================================================================
   Deportes · Medina Sidonia — lógica de la aplicación
   SPA sin dependencias: enrutado por hash, estado en localStorage.
   ========================================================================== */

(function () {
  'use strict';

  /* ---------- Utilidades ---------- */

  const $ = (sel, raiz) => (raiz || document).querySelector(sel);
  const $$ = (sel, raiz) => Array.from((raiz || document).querySelectorAll(sel));

  const esc = (texto) => String(texto)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const eur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
  const fmtEur = (n) => eur.format(n);

  const icono = (id, tam) =>
    `<svg width="${tam || 20}" height="${tam || 20}" aria-hidden="true"><use href="#${id}"/></svg>`;

  const pad2 = (n) => String(n).padStart(2, '0');

  const claveDeFecha = (d) =>
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  const fechaDesdeClave = (clave) => {
    const [a, m, d] = clave.split('-').map(Number);
    return new Date(a, m - 1, d);
  };

  const fmtDiaLargo = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtDiaCorto = new Intl.DateTimeFormat('es-ES', { weekday: 'short' });
  const fmtMesCorto = new Intl.DateTimeFormat('es-ES', { month: 'short' });

  const fechaLegible = (clave) => {
    const hoy = new Date();
    const hoyClave = claveDeFecha(hoy);
    // Suma en calendario local (sumar 86400000 ms falla en los cambios de hora)
    const mananaClave = claveDeFecha(new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 1));
    const texto = fmtDiaLargo.format(fechaDesdeClave(clave));
    if (clave === hoyClave) return `Hoy, ${texto}`;
    if (clave === mananaClave) return `Mañana, ${texto}`;
    return texto.charAt(0).toUpperCase() + texto.slice(1);
  };

  const minutosALabel = (min) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;

  /* Hash determinista (FNV-1a) para simular ocupación estable de pistas */
  const semilla = (texto) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < texto.length; i++) {
      h ^= texto.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0);
  };

  /* Devuelve el foco al equivalente de un control destruido por un re-render */
  const enfocar = (selector) => {
    const el = $(selector);
    if (el) el.focus({ preventScroll: true });
  };

  const instPorId = (id) => INSTALACIONES.find((i) => i.id === id);
  const clasePorId = (id) => CLASES.find((c) => c.id === id);
  const pistaDe = (inst, pistaId) => inst.pistas.find((p) => p.id === pistaId);

  /* ---------- Persistencia ---------- */

  const ALMACEN = {
    reservas: 'msd_reservas',
    inscripciones: 'msd_inscripciones',
    usuario: 'msd_usuario',
    ajustes: 'msd_clases_ajustes'
  };

  const leer = (clave, porDefecto) => {
    try {
      const bruto = localStorage.getItem(clave);
      return bruto ? JSON.parse(bruto) : porDefecto;
    } catch (e) {
      return porDefecto;
    }
  };

  const guardar = (clave, valor) => {
    try {
      localStorage.setItem(clave, JSON.stringify(valor));
    } catch (e) { /* modo privado: la sesión sigue funcionando sin persistir */ }
    if (typeof MSDSync !== 'undefined') MSDSync.empujar(clave);
  };

  /* Saneado defensivo: nada de lo que venga de localStorage se usa sin validar
     su esquema; un dato manipulado o corrupto se descarta en silencio. */

  const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

  function saneaReservas(lista) {
    if (!Array.isArray(lista)) return [];
    const ids = new Set();
    return lista.filter((r) => {
      if (!r || ids.has(r.id)) return false;
      ids.add(r.id);
      return true;
    }).filter((r) => {
      if (!r || typeof r !== 'object') return false;
      const inst = instPorId(r.instId);
      return typeof r.id === 'string' && /^r-\d+$/.test(r.id)
        && typeof r.localizador === 'string' && /^MS-[A-Z0-9]{1,8}$/.test(r.localizador)
        && typeof r.nombre === 'string' && r.nombre.length <= 120
        && RE_FECHA.test(String(r.fecha))
        && Number.isInteger(r.hora) && r.hora >= 0 && r.hora < 1440
        && typeof r.precio === 'number' && isFinite(r.precio) && r.precio >= 0
        && !!inst && !!pistaDe(inst, r.pistaId);
    });
  }

  function saneaInscripciones(lista) {
    if (!Array.isArray(lista)) return [];
    const vistas = new Set();
    return lista.filter((i) => {
      const clave = i && `${i.claseId}|${i.usuarioId}`;
      const valida = i && typeof i === 'object'
        && !!clasePorId(i.claseId)
        && typeof i.usuarioId === 'string' && /^u-[a-z0-9]+$/.test(i.usuarioId)
        && (i.estado === 'inscrito' || i.estado === 'espera')
        && Number.isInteger(i.desde)
        && !vistas.has(clave);
      if (valida) vistas.add(clave);
      return valida;
    });
  }

  /* Ajustes de clases: desplazamientos sobre los datos base (promociones de cola
     simuladas por la automatización o desde el panel de administración). */
  function saneaAjustesClases(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const limpio = {};
    for (const [id, a] of Object.entries(obj)) {
      const clase = clasePorId(id);
      if (!clase || !a || typeof a !== 'object') continue;
      const ins = Number.isInteger(a.inscritosBase) ? a.inscritosBase : clase.inscritosBase;
      const cola = Number.isInteger(a.colaBase) ? a.colaBase : clase.colaBase;
      limpio[id] = {
        inscritosBase: Math.min(Math.max(ins, 0), clase.aforo),
        colaBase: Math.max(cola, 0)
      };
    }
    return limpio;
  }

  function saneaUsuario(u) {
    if (!u || typeof u !== 'object') return null;
    const texto = (v) => (typeof v === 'string' ? v.slice(0, 120) : '');
    return { nombre: texto(u.nombre), email: texto(u.email), telefono: texto(u.telefono) };
  }

  /* Bloqueos de pista (mantenimiento, competición, obra) */
  function saneaBloqueos(lista) {
    if (!Array.isArray(lista)) return [];
    return lista.filter((b) => b && typeof b === 'object'
      && typeof b.id === 'string'
      && typeof b.pistaId === 'string'
      && RE_FECHA.test(String(b.fecha))
      && Number.isInteger(b.desdeMin) && Number.isInteger(b.hastaMin)
      && b.desdeMin >= 0 && b.hastaMin <= 1440 && b.desdeMin < b.hastaMin
      && typeof b.motivo === 'string' && b.motivo.length <= 120);
  }

  let reservas = saneaReservas(leer(ALMACEN.reservas, []));
  let inscripciones = saneaInscripciones(leer(ALMACEN.inscripciones, []));
  let usuario = saneaUsuario(leer(ALMACEN.usuario, null));
  let ajustesClases = saneaAjustesClases(leer(ALMACEN.ajustes, {}));
  let bloqueos = saneaBloqueos(leer('msd_bloqueos', []));

  const bloqueoDe = (pistaId, fecha, iniMin, finMin) =>
    bloqueos.find((b) => b.pistaId === pistaId && b.fecha === fecha
      && iniMin < b.hastaMin && finMin > b.desdeMin) || null;

  /* ---------- Sesión ---------- */

  const sesion = () => MSDAuth.sesionActual();
  let destinoTrasAcceso = null;

  function exigirSesion(destino, motivo) {
    if (sesion()) return true;
    destinoTrasAcceso = destino;
    const p = $('#acceso-motivo');
    if (p && motivo) p.textContent = motivo;
    location.hash = '#/acceso';
    return false;
  }

  function pintarSesion() {
    const u = sesion();
    const chip = $('#chip-usuario');
    const chipTexto = $('#chip-usuario-texto');
    const navPerfil = $('#nav-inf-perfil');
    if (u) {
      chipTexto.textContent = u.nombre.split(' ')[0];
      chip.href = '#/perfil';
      navPerfil.href = '#/perfil';
      navPerfil.querySelector('span').textContent = 'Perfil';
    } else {
      chipTexto.textContent = 'Acceder';
      chip.href = '#/acceso';
      navPerfil.href = '#/acceso';
      navPerfil.querySelector('span').textContent = 'Acceder';
    }
    pintarCampana();
  }

  /* ---------- Estado de la reserva en curso ---------- */

  const seleccion = {
    instId: null,
    pistaId: null,
    fecha: null,   // clave YYYY-MM-DD
    hora: null,    // minutos desde medianoche
    reiniciar() {
      this.instId = null; this.pistaId = null; this.fecha = null; this.hora = null;
    }
  };

  let ultimaReserva = null;

  /* ---------- Avisos (toast) ---------- */

  const contAvisos = $('#avisos');

  function avisar(mensaje, tipo) {
    const aviso = document.createElement('div');
    aviso.className = `aviso${tipo === 'error' ? ' aviso--error' : ' aviso--ok'}`;
    aviso.innerHTML = `${icono(tipo === 'error' ? 'i-info' : 'i-check', 18)}<span>${esc(mensaje)}</span>`;
    contAvisos.appendChild(aviso);
    setTimeout(() => aviso.remove(), 4200);
  }

  /* ---------- Diálogo de confirmación accesible ---------- */

  const dlgFondo = $('#dialogo-fondo');
  const dlgTitulo = $('#dialogo-titulo');
  const dlgTexto = $('#dialogo-texto');
  const dlgCancelar = $('#dialogo-cancelar');
  const dlgAceptar = $('#dialogo-aceptar');
  let dlgResolver = null;
  let dlgFocoPrevio = null;
  let dlgAbiertoEn = 0;

  function confirmar(titulo, texto, textoAceptar) {
    return new Promise((resolver) => {
      dlgResolver = resolver;
      dlgFocoPrevio = document.activeElement;
      dlgAbiertoEn = performance.now();
      dlgTitulo.textContent = titulo;
      dlgTexto.textContent = texto;
      dlgAceptar.textContent = textoAceptar || 'Sí, cancelar';
      dlgFondo.hidden = false;
      dlgCancelar.focus();
    });
  }

  function cerrarDialogo(respuesta) {
    if (!dlgResolver) return;
    dlgFondo.hidden = true;
    const resolver = dlgResolver;
    dlgResolver = null;
    if (dlgFocoPrevio && document.contains(dlgFocoPrevio)) dlgFocoPrevio.focus();
    resolver(respuesta);
  }

  dlgCancelar.addEventListener('click', () => cerrarDialogo(false));
  dlgAceptar.addEventListener('click', () => cerrarDialogo(true));
  dlgFondo.addEventListener('click', (ev) => {
    // Ignora el segundo clic de un doble clic que abrió el diálogo (aterriza en el fondo)
    if (ev.target === dlgFondo && performance.now() - dlgAbiertoEn > 350) cerrarDialogo(false);
  });
  document.addEventListener('keydown', (ev) => {
    if (dlgFondo.hidden) return;
    if (ev.key === 'Escape') { ev.preventDefault(); cerrarDialogo(false); }
    if (ev.key === 'Tab') {
      // Trampa de foco simple entre los dos botones del diálogo
      ev.preventDefault();
      (document.activeElement === dlgCancelar ? dlgAceptar : dlgCancelar).focus();
    }
  });

  /* ==========================================================================
     Disponibilidad de pistas
     ========================================================================== */

  function horarioDelDia(clave) {
    const dia = fechaDesdeClave(clave).getDay(); // 0 domingo … 6 sábado
    return (dia === 0 || dia === 6) ? HORARIO.finde : HORARIO.laborable;
  }

  /* Probabilidad de ocupación verosímil: una instalación municipal se llena
     por las tardes entre semana y el sábado por la mañana, y respira a media
     mañana. La parrilla tiene que contar esa historia sola. */
  function probOcupacion(clave, horaMin) {
    const dia = fechaDesdeClave(clave).getDay(); // 0 domingo … 6 sábado
    const h = horaMin / 60;
    if (dia >= 1 && dia <= 5) {
      if (h >= 18 && h < 21) return 85;  // la hora punta de verdad
      if (h >= 21) return 55;
      if (h >= 9 && h < 13) return 15;   // media mañana, casi vacío
      return 38;
    }
    if (dia === 6) return h < 14 ? 88 : 45; // sábado por la mañana, a tope
    return h < 14 ? 60 : 30;                // domingo
  }

  /* Devuelve la lista de tramos de una pista en un día:
     { hora, label, estado: 'libre' | 'ocupada' | 'pasada' | 'bloqueada' | 'tuya', luz } */
  function tramosDe(inst, pistaId, clave) {
    const [abre, cierra] = horarioDelDia(clave);
    const tramos = [];
    const esHoy = clave === claveDeFecha(new Date());
    const ahora = new Date();
    const minutosAhora = ahora.getHours() * 60 + ahora.getMinutes();
    const u = sesion();

    for (let ini = abre * 60; ini + inst.duracionMin <= cierra * 60; ini += inst.duracionMin) {
      const ocupadaPorOtros = semilla(`${clave}|${pistaId}|${ini}`) % 100 < probOcupacion(clave, ini);
      const mia = reservas.find((r) =>
        r.pistaId === pistaId && r.fecha === clave && r.hora === ini);
      const bloqueo = bloqueoDe(pistaId, clave, ini, ini + inst.duracionMin);
      let estado = 'libre';
      if (esHoy && ini <= minutosAhora) estado = 'pasada';
      else if (bloqueo) estado = 'bloqueada';
      else if (mia && u && mia.usuarioId === u.id) estado = 'tuya';
      else if (ocupadaPorOtros || mia) estado = 'ocupada';
      tramos.push({
        hora: ini,
        label: minutosALabel(ini),
        estado,
        motivo: bloqueo ? bloqueo.motivo : null,
        luz: inst.exterior && ini >= HORA_LUZ * 60
      });
    }
    return tramos;
  }

  function precioDeSeleccion() {
    const inst = instPorId(seleccion.instId);
    if (!inst || seleccion.hora == null) return 0;
    const luz = inst.exterior && seleccion.hora >= HORA_LUZ * 60;
    return inst.precio + (luz ? inst.suplementoLuz : 0);
  }

  /* ==========================================================================
     Clases: estado combinando datos base + inscripción del usuario
     ========================================================================== */

  const baseInscritos = (clase) =>
    (ajustesClases[clase.id] ? ajustesClases[clase.id].inscritosBase : clase.inscritosBase);
  const baseCola = (clase) =>
    (ajustesClases[clase.id] ? ajustesClases[clase.id].colaBase : clase.colaBase);

  const inscripcionesDe = (claseId) => inscripciones.filter((i) => i.claseId === claseId);

  function estadoClase(clase) {
    const u = sesion();
    const deClase = inscripcionesDe(clase.id);
    const mia = u ? deClase.find((i) => i.usuarioId === u.id) : null;
    const inscritos = baseInscritos(clase) + deClase.filter((i) => i.estado === 'inscrito').length;
    const libres = Math.max(0, clase.aforo - inscritos);
    const esperas = deClase.filter((i) => i.estado === 'espera').sort((a, b) => a.desde - b.desde);
    let posicionMia = null;
    if (mia && mia.estado === 'espera') {
      posicionMia = baseCola(clase) + esperas.findIndex((i) => i === mia) + 1;
    }
    return {
      mia,
      posicionMia,
      inscritos,
      libres,
      llena: libres === 0,
      cola: baseCola(clase) + esperas.length
    };
  }

  /* Al liberarse una plaza, la primera persona de la cola pasa automáticamente */
  function promocionarCola(clase) {
    const est = estadoClase(clase);
    if (est.libres <= 0 || est.cola === 0) return;
    if (baseCola(clase) > 0) {
      // La cola simulada llevaba más tiempo esperando: entra esa persona
      ajustesClases[clase.id] = {
        inscritosBase: baseInscritos(clase) + 1,
        colaBase: baseCola(clase) - 1
      };
      guardar(ALMACEN.ajustes, ajustesClases);
      MSDAuth.anotarAutomatizacion('clases',
        `Plaza libre en ${clase.nombre}: la siguiente persona de la lista de espera ha sido inscrita y avisada automáticamente.`);
      return;
    }
    const siguiente = inscripcionesDe(clase.id)
      .filter((i) => i.estado === 'espera')
      .sort((a, b) => a.desde - b.desde)[0];
    if (!siguiente) return;
    siguiente.estado = 'inscrito';
    guardar(ALMACEN.inscripciones, inscripciones);
    MSDAuth.asegurarCarnet(siguiente.usuarioId);
    const quien = MSDAuth.buscarPorId(siguiente.usuarioId);
    MSDAuth.anotarAutomatizacion('clases',
      `Plaza libre en ${clase.nombre}: ${quien ? quien.nombre : 'una persona en espera'} pasa de la cola a inscrita (aviso enviado automáticamente).`);
    MSDAuth.notificar(siguiente.usuarioId, `¡Plaza libre en ${clase.nombre}! Ya estás dentro: te tocaba a ti en la cola.`);
    const u = sesion();
    if (u && siguiente.usuarioId === u.id) {
      avisar(`¡Buena noticia! Ha quedado plaza en ${clase.nombre} y ya estás dentro.`);
    }
    pintarCampana();
  }

  /* ==========================================================================
     Renderizado
     ========================================================================== */

  /* ---------- Tarjetas de instalación ---------- */

  function htmlTarjetaInstalacion(inst) {
    return `
      <a class="tarjeta-inst" href="#/reservar" data-inst="${inst.id}">
        <span class="tarjeta-inst__icono">${icono(inst.icono, 26)}</span>
        <h3>${esc(inst.nombre)}</h3>
        <p class="tarjeta-inst__detalle">${esc(inst.detalle)}</p>
        <span class="tarjeta-inst__pie">
          <span class="tarjeta-inst__precio">${fmtEur(inst.precio)} <small>/ ${esc(inst.unidad)}</small></span>
          <span class="tarjeta-inst__accion">Reservar ${icono('i-chevron-d', 15)}</span>
        </span>
      </a>`;
  }

  function pintarInstalaciones(contenedor) {
    contenedor.innerHTML = INSTALACIONES.map(htmlTarjetaInstalacion).join('');
  }

  /* ---------- Tarjetas de clase ---------- */

  function htmlTarjetaClase(clase) {
    const est = estadoClase(clase);
    const ratio = Math.min(100, Math.round((est.inscritos / clase.aforo) * 100));

    let insignia, claseBarra = '';
    if (est.llena) {
      insignia = '<span class="insignia insignia--llena">Completa</span>';
      claseBarra = ' aforo__relleno--llena';
    } else if (est.libres <= 3) {
      insignia = `<span class="insignia insignia--pocas">Quedan ${est.libres}</span>`;
      claseBarra = ' aforo__relleno--pocas';
    } else {
      insignia = `<span class="insignia insignia--plazas">${est.libres} plazas libres</span>`;
    }

    let accion;
    if (est.mia && est.mia.estado === 'inscrito') {
      accion = `<span class="estado-inscrito">${icono('i-check', 17)} Inscrito</span>
        <button class="boton--texto" type="button" data-baja="${clase.id}">Darme de baja</button>`;
    } else if (est.mia && est.mia.estado === 'espera') {
      accion = `<span class="estado-espera">${icono('i-cola', 17)} En cola · puesto ${est.posicionMia}</span>
        <button class="boton--texto" type="button" data-baja="${clase.id}">Salir de la cola</button>`;
    } else if (est.llena) {
      accion = `<button class="boton boton--secundario" type="button" data-cola="${clase.id}">
        ${icono('i-cola', 17)} Ponerme a la cola (${est.cola} esperando)</button>`;
    } else {
      accion = `<button class="boton boton--primario" type="button" data-inscribir="${clase.id}">Inscribirme</button>`;
    }

    return `
      <article class="tarjeta-clase" aria-label="${esc(clase.nombre)}">
        <div class="tarjeta-clase__cima">
          <div>
            <h3>${esc(clase.nombre)}</h3>
            <p class="tarjeta-clase__lugar">${esc(clase.lugar)}</p>
          </div>
          ${insignia}
        </div>
        <ul class="tarjeta-clase__meta">
          <li>${icono('i-calendario', 17)} ${esc(clase.dias)}</li>
          <li>${icono('i-reloj', 17)} ${esc(clase.hora)}</li>
          <li>${icono('i-usuario', 17)} ${esc(clase.monitor)}</li>
        </ul>
        <div class="aforo">
          <div class="aforo__texto"><span>Ocupación</span><span>${est.inscritos} / ${clase.aforo}</span></div>
          <div class="aforo__barra" role="img" aria-label="Ocupación: ${est.inscritos} de ${clase.aforo} plazas">
            <div class="aforo__relleno${claseBarra}" style="width:${ratio}%"></div>
          </div>
        </div>
        <div class="tarjeta-clase__pie">
          <span class="tarjeta-clase__precio">${fmtEur(clase.precioMes)} <small>/ mes</small></span>
          <span style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end">${accion}</span>
        </div>
      </article>`;
  }

  let filtroClases = 'todas';

  function pintarClases() {
    const cont = $('#grid-clases');
    if (!cont) return;

    const filtradas = CLASES.filter((c) => {
      if (filtroClases === 'todas') return true;
      if (filtroClases === 'con-plazas') return !estadoClase(c).llena;
      return c.espacio === filtroClases;
    });

    cont.innerHTML = filtradas.length
      ? filtradas.map(htmlTarjetaClase).join('')
      : `<div class="aviso-vacio"><strong>No hay clases con ese filtro</strong>Prueba con otro espacio o quita el filtro.</div>`;

    const filtros = $('#filtros-clases');
    filtros.innerHTML = FILTROS_CLASES.map((f) =>
      `<button class="chip" type="button" data-filtro="${f.id}" aria-pressed="${f.id === filtroClases}">${esc(f.nombre)}</button>`
    ).join('');
  }

  function pintarClasesInicio() {
    const cont = $('#inicio-clases');
    const destacadas = ['zumba', 'pilates', 'natacion-adultos'].map(clasePorId).filter(Boolean);
    cont.innerHTML = destacadas.map(htmlTarjetaClase).join('');
  }

  /* ==========================================================================
     La parrilla: disponibilidad del día entero en una pantalla
     Horas en la columna izquierda, pistas en columnas, cada celda un botón.
     ========================================================================== */


  /* Selector de días POR SEMANAS: una semana (Lun–Dom) a la vista, con ‹ › para
     cambiar de semana. Los días fuera del plazo de reserva salen en gris. */
  let semanaLunes = null;
  const lunesDe = (d) => {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // 0 = lunes
    return x;
  };
  const fechaDeClave = (clave) => { const [a, m, dd] = clave.split('-').map(Number); return new Date(a, m - 1, dd); };
  const mismaFecha = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  function pintarTiraDias() {
    const ventana = diasReservables();
    const reservables = new Map(ventana.map((v) => [v.clave, v]));
    if (!seleccion.fecha || !reservables.has(seleccion.fecha)) {
      seleccion.fecha = ventana[0].clave;
    }
    const primerLunes = lunesDe(ventana[0].d);
    const ultimoLunes = lunesDe(ventana[ventana.length - 1].d);
    if (!semanaLunes) semanaLunes = lunesDe(fechaDeClave(seleccion.fecha));
    if (semanaLunes < primerLunes) semanaLunes = new Date(primerLunes);
    if (semanaLunes > ultimoLunes) semanaLunes = new Date(ultimoLunes);

    const hoy = new Date();
    const dias7 = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(semanaLunes.getFullYear(), semanaLunes.getMonth(), semanaLunes.getDate() + i);
      const clave = claveDeFecha(d);
      return { d, clave, disponible: reservables.has(clave), esHoy: mismaFecha(d, hoy) };
    });

    const fin = dias7[6].d;
    const mesIni = fmtMesCorto.format(semanaLunes).replace('.', '');
    const mesFin = fmtMesCorto.format(fin).replace('.', '');
    const rango = semanaLunes.getMonth() === fin.getMonth()
      ? `${semanaLunes.getDate()} – ${fin.getDate()} ${mesFin}`
      : `${semanaLunes.getDate()} ${mesIni} – ${fin.getDate()} ${mesFin}`;
    const hayAntes = semanaLunes > primerLunes;
    const hayDespues = semanaLunes < ultimoLunes;

    $('#tira-dias').innerHTML = `
      <div class="semana-nav">
        <button class="semana-nav__flecha" type="button" data-semana="-1" ${hayAntes ? '' : 'disabled'} aria-label="Semana anterior">‹</button>
        <span class="semana-nav__rango">${esc(rango)}</span>
        <button class="semana-nav__flecha" type="button" data-semana="1" ${hayDespues ? '' : 'disabled'} aria-label="Semana siguiente">›</button>
      </div>
      <div class="semana-dias">
        ${dias7.map(({ d, clave, disponible, esHoy }) => `
          <button class="dia${esHoy ? ' dia--hoy' : ''}" type="button" data-dia="${clave}" ${disponible ? '' : 'disabled'}
                  aria-pressed="${clave === seleccion.fecha}" aria-label="${esc(fechaLegible(clave))}">
            <span class="dia__semana">${esc(fmtDiaCorto.format(d).replace('.', ''))}</span>
            <span class="dia__num">${d.getDate()}</span>
          </button>`).join('')}
      </div>`;
  }

  /* Ventana de reserva configurable desde el panel (msd_config, sincronizada):
     desde qué día se abre la reserva y cuántos días quedan disponibles. */
  function configReserva() {
    const c = leer('msd_config', {});
    const desde = (c && Number.isInteger(c.reservaDesdeDias))
      ? Math.min(Math.max(c.reservaDesdeDias, 0), 7) : 0;
    const dias = (c && Number.isInteger(c.reservaDiasVentana))
      ? Math.min(Math.max(c.reservaDiasVentana, 1), DIAS_VISIBLES) : DIAS_VISIBLES;
    return { desde, dias };
  }

  function diasReservables() {
    const { desde, dias } = configReserva();
    const hoy = new Date();
    return Array.from({ length: dias }, (_, i) => {
      const d = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + desde + i);
      return { d, clave: claveDeFecha(d), desplazamiento: desde + i };
    });
  }

  /* Secciones desplegadas del acordeón (persiste al cambiar de día) */
  const seccionesAbiertas = new Set();

  function pintarParrilla() {
    pintarTiraDias();
    const clave = seleccion.fecha;
    const cont = $('#parrilla');

    // Si se llegó con una instalación elegida (tarjeta de portada, «reservar
    // otra vez»…), su sección se abre sola
    if (seleccion.instId) seccionesAbiertas.add(seleccion.instId);

    cont.innerHTML = INSTALACIONES.map((inst) => {
      let libres = 0;
      const filas = inst.pistas.map((pista) => {
        // Las horas ya pasadas no se pintan: menos ruido, más claridad
        const tramos = tramosDe(inst, pista.id, clave).filter((t) => t.estado !== 'pasada');
        libres += tramos.filter((t) => t.estado === 'libre').length;
        const fichas = tramos.map((t) => {
          const fin = minutosALabel(t.hora + inst.duracionMin);
          const luzTxt = t.luz ? `, con suplemento de luz de ${fmtEur(inst.suplementoLuz)}` : '';
          if (t.estado === 'libre') {
            return `<button type="button" class="hora-ficha hora-ficha--libre"
              data-celda="1" data-inst="${inst.id}" data-pista="${pista.id}" data-fecha="${esc(clave)}" data-hora="${t.hora}" data-estado="libre"
              aria-label="${esc(pista.nombre)}, de ${t.label} a ${fin}, libre, ${fmtEur(inst.precio)}${luzTxt}. Reservar.">
              ${t.label}${t.luz ? `<span class="hora-ficha__luz"><span class="punto-luz" aria-hidden="true"></span>+${fmtEur(inst.suplementoLuz)}</span>` : ''}
            </button>`;
          }
          if (t.estado === 'tuya') {
            return `<button type="button" class="hora-ficha hora-ficha--tuya"
              data-celda="1" data-estado="tuya"
              aria-label="${esc(pista.nombre)}, de ${t.label} a ${fin}: tu reserva. Ver mis reservas.">
              ${t.label} · Tuya
            </button>`;
          }
          if (t.estado === 'bloqueada') {
            return `<span class="hora-ficha hora-ficha--bloqueada" title="${esc(t.motivo || 'Bloqueada')}"
              aria-label="${esc(pista.nombre)}, de ${t.label} a ${fin}, bloqueada${t.motivo ? ' por ' + esc(t.motivo) : ''}.">${t.label}</span>`;
          }
          return `<span class="hora-ficha hora-ficha--ocupada"
            aria-label="${esc(pista.nombre)}, de ${t.label} a ${fin}, ocupada.">${t.label}</span>`;
        }).join('');
        return `
          <div class="fila-pista">
            <span class="fila-pista__nombre">${esc(pista.nombre)}</span>
            <div class="fila-pista__horas">${fichas || '<span class="fila-pista__vacio">No quedan horas hoy</span>'}</div>
          </div>`;
      }).join('');

      const abierta = seccionesAbiertas.has(inst.id);
      return `
        <section class="sec-instalacion" aria-label="${esc(inst.nombre)}">
          <h3 class="sec-instalacion__titulo">
            <button type="button" class="sec-instalacion__boton" data-toggle-seccion="${inst.id}"
                    aria-expanded="${abierta}" aria-controls="horarios-${inst.id}">
              <span class="tarjeta-inst__icono">${icono(inst.icono, 22)}</span>
              <span class="sec-instalacion__quien">
                <span class="sec-instalacion__nombre">${esc(inst.nombre)}</span>
                <span class="sec-instalacion__precio">${fmtEur(inst.precio)} / ${esc(inst.unidad)}${inst.exterior && inst.suplementoLuz ? ` · con luz +${fmtEur(inst.suplementoLuz)}` : ''}</span>
              </span>
              <span class="insignia ${libres ? 'insignia--plazas' : 'insignia--llena'}">${libres ? libres + ' huecos libres' : 'Completo'}</span>
              <svg class="sec-instalacion__flecha" width="18" height="18" aria-hidden="true"><use href="#i-chevron-d"/></svg>
            </button>
          </h3>
          <div class="sec-instalacion__horarios" id="horarios-${inst.id}" ${abierta ? '' : 'hidden'}>
            ${filas}
          </div>
        </section>`;
    }).join('');
  }

  /* ---------- Paso 2: pista, día y hora ---------- */

  function pintarPaso2() {
    const inst = instPorId(seleccion.instId);
    if (!inst) return;

    $('#horario-resumen-inst').innerHTML = `
      <span class="tarjeta-inst__icono">${icono(inst.icono, 24)}</span>
      <div>
        <h2>${esc(inst.nombre)}</h2>
        <p>${fmtEur(inst.precio)} / ${esc(inst.unidad)}${inst.exterior && inst.suplementoLuz ? ` · con luz +${fmtEur(inst.suplementoLuz)}` : ''}</p>
      </div>`;

    // Selector de pista (se oculta si solo hay una)
    const grupoPistas = $('#selector-pista-grupo');
    if (inst.pistas.length > 1) {
      grupoPistas.hidden = false;
      $('#selector-pista').innerHTML = inst.pistas.map((p) =>
        `<button class="chip" type="button" data-pista="${p.id}" aria-pressed="${p.id === seleccion.pistaId}">${esc(p.nombre)}</button>`
      ).join('');
    } else {
      grupoPistas.hidden = true;
    }

    // Tira de días (misma vista semanal que la parrilla)
    pintarTiraDias();

    pintarTramos();
  }

  function pintarTramos() {
    const inst = instPorId(seleccion.instId);
    if (!inst) return;
    const tramos = tramosDe(inst, seleccion.pistaId, seleccion.fecha);
    const cont = $('#malla-horas');

    const algunoLibre = tramos.some((t) => t.estado === 'libre');

    cont.innerHTML = tramos.map((t) => {
      const deshabilitado = t.estado !== 'libre';
      const seleccionado = seleccion.hora === t.hora;
      const etiquetas = [t.label];
      etiquetas.push(t.estado === 'libre' ? 'libre' : (t.estado === 'pasada' ? 'hora pasada' : 'ocupada'));
      if (t.luz && t.estado === 'libre') etiquetas.push('con suplemento de luz');
      return `
        <button class="slot" type="button" data-hora="${t.hora}"
                ${deshabilitado ? 'disabled' : `aria-pressed="${seleccionado}"`}
                aria-label="${etiquetas.join(', ')}">
          ${t.label}
          ${t.luz ? `<small>${icono('i-luna', 12)} +${fmtEur(inst.suplementoLuz)}</small>` : ''}
        </button>`;
    }).join('');

    if (!algunoLibre) {
      cont.insertAdjacentHTML('afterend',
        `<div class="aviso-vacio" id="aviso-sin-horas" style="margin-top:14px">
           <strong>No quedan horas libres este día</strong>Prueba otro día u otra pista.
         </div>`);
    } else {
      const previo = $('#aviso-sin-horas');
      if (previo) previo.remove();
    }
    // Limpia avisos duplicados si se repinta
    $$('#aviso-sin-horas').slice(1).forEach((n) => n.remove());

    pintarBarraContinuar();
  }

  function pintarBarraContinuar() {
    const barra = $('#barra-continuar');
    const inst = instPorId(seleccion.instId);
    if (!inst || seleccion.hora == null) {
      barra.hidden = true;
      return;
    }
    const pista = pistaDe(inst, seleccion.pistaId);
    barra.hidden = false;
    $('#resumen-seleccion').innerHTML = `
      <strong>${esc(inst.nombre)} · ${esc(pista.nombre)}</strong>
      <span>${esc(fechaLegible(seleccion.fecha))} · ${minutosALabel(seleccion.hora)} · ${fmtEur(precioDeSeleccion())}</span>`;
  }

  /* ---------- Paso 3: resumen + formulario ---------- */

  function pintarResumenFinal() {
    const inst = instPorId(seleccion.instId);
    if (!inst || seleccion.hora == null) return;
    const pista = pistaDe(inst, seleccion.pistaId);
    const luz = inst.exterior && seleccion.hora >= HORA_LUZ * 60;
    const finMin = seleccion.hora + inst.duracionMin;

    $('#resumen-final').innerHTML = `
      <ul class="resumen-lista">
        <li><span>Instalación</span><span>${esc(inst.nombre)} · ${esc(pista.nombre)}</span></li>
        <li><span>Día</span><span>${esc(fechaLegible(seleccion.fecha))}</span></li>
        <li><span>Hora</span><span>${minutosALabel(seleccion.hora)} – ${minutosALabel(finMin)}</span></li>
        <li><span>Alquiler</span><span>${fmtEur(inst.precio)}</span></li>
        ${luz ? `<li><span>Suplemento de luz</span><span>${fmtEur(inst.suplementoLuz)}</span></li>` : ''}
      </ul>
      <div class="resumen-total"><span>Total</span><span>${fmtEur(precioDeSeleccion())}</span></div>
      <p class="resumen-nota">${icono('i-info', 16)} Recibirás tu justificante de liquidación de precio público (exenta de IVA). Pago en la instalación o mediante carta de pago. Cancelación gratuita hasta 24 h antes.</p>`;

    // Precarga los datos desde la cuenta (o de la última reserva)
    const u = sesion();
    const datos = u || usuario;
    if (datos) {
      $('#campo-nombre').value = datos.nombre || '';
      $('#campo-email').value = datos.email || '';
      $('#campo-telefono').value = datos.telefono || '';
    }
  }

  /* ---------- Éxito ---------- */

  function pintarExito() {
    if (!ultimaReserva) return;
    const inst = instPorId(ultimaReserva.instId);
    const pista = pistaDe(inst, ultimaReserva.pistaId);
    $('#exito-ticket').innerHTML = `
      <p class="exito__loc">${esc(ultimaReserva.localizador)}</p>
      <ul class="resumen-lista">
        <li><span>Instalación</span><span>${esc(inst.nombre)} · ${esc(pista.nombre)}</span></li>
        <li><span>Día</span><span>${esc(fechaLegible(ultimaReserva.fecha))}</span></li>
        <li><span>Hora</span><span>${minutosALabel(ultimaReserva.hora)} – ${minutosALabel(ultimaReserva.hora + inst.duracionMin)}</span></li>
        <li><span>A nombre de</span><span>${esc(ultimaReserva.nombre)}</span></li>
      </ul>
      <div class="resumen-total"><span>Total</span><span>${fmtEur(ultimaReserva.precio)}</span></div>`;
  }

  /* ---------- Mis reservas ---------- */

  function pintarMisReservas() {
    const contPistas = $('#mis-pistas');
    const contClases = $('#mis-clases');
    const ahora = new Date();
    const minutosAhora = ahora.getHours() * 60 + ahora.getMinutes();
    const hoyClave = claveDeFecha(ahora);

    const u = sesion();
    if (!u) {
      const invitado = `
        <div class="aviso-vacio">
          <strong>Inicia sesión para ver tus reservas</strong>
          <a class="enlace-flecha" href="#/acceso" style="justify-content:center">Acceder o crear cuenta ${icono('i-chevron-d', 15)}</a>
        </div>`;
      contPistas.innerHTML = invitado;
      contClases.innerHTML = '';
      return;
    }

    const misReservas = reservas.filter((r) => r.usuarioId === u.id);
    const misInscripciones = inscripciones.filter((i) => i.usuarioId === u.id);

    if (!misReservas.length) {
      contPistas.innerHTML = `
        <div class="aviso-vacio">
          <strong>Todavía no tienes reservas de pista</strong>
          <a class="enlace-flecha" href="#/reservar" style="justify-content:center">Reservar una pista ${icono('i-chevron-d', 15)}</a>
        </div>`;
    } else {
      const ordenadas = misReservas.slice().sort((a, b) =>
        a.fecha === b.fecha ? a.hora - b.hora : (a.fecha < b.fecha ? -1 : 1));
      contPistas.innerHTML = ordenadas.map((r) => {
        const inst = instPorId(r.instId);
        const pista = pistaDe(inst, r.pistaId);
        const pasada = r.fecha < hoyClave || (r.fecha === hoyClave && r.hora <= minutosAhora);
        return `
          <div class="tarjeta-reserva">
            <span class="tarjeta-reserva__icono">${icono(inst.icono, 24)}</span>
            <div class="tarjeta-reserva__datos">
              <strong>${esc(inst.nombre)} · ${esc(pista.nombre)}</strong>
              <span>${esc(fechaLegible(r.fecha))} · ${minutosALabel(r.hora)} · ${fmtEur(r.precio)}</span>
            </div>
            <span class="tarjeta-reserva__loc" title="Localizador">${esc(r.localizador)}</span>
            <div class="tarjeta-reserva__acciones">
              ${pasada
                ? `<span class="insignia insignia--plazas">Disfrutada</span>
                   <button class="boton boton--secundario" type="button" data-repetir="${esc(r.id)}">Reservar otra vez</button>`
                : `<button class="boton boton--secundario" type="button" data-ics="${esc(r.id)}" title="Descargar para tu calendario">
                     ${icono('i-descargar', 15)} Calendario
                   </button>
                   <button class="boton--texto" type="button" data-cancelar-reserva="${esc(r.id)}">Cancelar</button>`}
            </div>
          </div>`;
      }).join('');
    }

    if (!misInscripciones.length) {
      contClases.innerHTML = `
        <div class="aviso-vacio">
          <strong>No estás inscrito en ninguna clase</strong>
          <a class="enlace-flecha" href="#/clases" style="justify-content:center">Ver clases dirigidas ${icono('i-chevron-d', 15)}</a>
        </div>`;
    } else {
      contClases.innerHTML = misInscripciones.map((i) => {
        const clase = clasePorId(i.claseId);
        if (!clase) return '';
        const enEspera = i.estado === 'espera';
        const posicion = enEspera ? estadoClase(clase).posicionMia : null;
        return `
          <div class="tarjeta-reserva">
            <span class="tarjeta-reserva__icono">${icono(clase.icono, 24)}</span>
            <div class="tarjeta-reserva__datos">
              <strong>${esc(clase.nombre)}</strong>
              <span>${esc(clase.dias)} · ${esc(clase.hora)} · ${esc(clase.lugar)}</span>
            </div>
            ${enEspera
              ? `<span class="estado-espera">${icono('i-cola', 17)} En cola · puesto ${posicion}</span>`
              : `<span class="estado-inscrito">${icono('i-check', 17)} Inscrito</span>`}
            <div class="tarjeta-reserva__acciones">
              <button class="boton--texto" type="button" data-baja="${clase.id}">${enEspera ? 'Salir de la cola' : 'Darme de baja'}</button>
            </div>
          </div>`;
      }).join('');
    }
  }

  /* ==========================================================================
     Acciones
     ========================================================================== */

  function seleccionarInstalacion(instId) {
    const inst = instPorId(instId);
    if (!inst) return;
    if (seleccion.instId !== instId) {
      seleccion.instId = instId;
      seleccion.pistaId = inst.pistas[0].id;
      seleccion.hora = null;
    }
  }

  function inscribirse(claseId) {
    if (!exigirSesion('#/clases', 'Para inscribirte en una clase necesitas tu cuenta deportiva.')) return;
    const clase = clasePorId(claseId);
    const est = estadoClase(clase);
    if (est.mia) return;
    if (est.llena) { avisar('La clase está completa. Puedes ponerte a la cola.', 'error'); return; }
    inscripciones.push({ claseId, usuarioId: sesion().id, estado: 'inscrito', desde: Date.now() });
    guardar(ALMACEN.inscripciones, inscripciones);
    MSDAuth.asegurarCarnet(sesion().id); // con la inscripción llega su carnet QR
    avisar(`Inscripción confirmada en ${clase.nombre}.`);
    pintarClases(); pintarClasesInicio(); pintarCampana();
  }

  function ponerseEnCola(claseId) {
    if (!exigirSesion('#/clases', 'Para ponerte a la cola de una clase necesitas tu cuenta deportiva.')) return;
    const clase = clasePorId(claseId);
    const est = estadoClase(clase);
    if (est.mia) return;
    inscripciones.push({ claseId, usuarioId: sesion().id, estado: 'espera', desde: Date.now() });
    guardar(ALMACEN.inscripciones, inscripciones);
    const posicion = estadoClase(clase).posicionMia;
    avisar(`Estás en la cola de ${clase.nombre}: puesto ${posicion}. Te avisaremos si queda plaza.`);
    pintarClases(); pintarClasesInicio();
  }

  async function darseDeBaja(claseId) {
    const u = sesion();
    const clase = clasePorId(claseId);
    const mia = u && inscripciones.find((i) => i.claseId === claseId && i.usuarioId === u.id);
    if (!clase || !mia) return;
    const enEspera = mia.estado === 'espera';
    const posicion = estadoClase(clase).posicionMia;
    const ok = await confirmar(
      enEspera ? '¿Salir de la lista de espera?' : '¿Darte de baja de la clase?',
      enEspera
        ? `Perderás tu puesto ${posicion} en la cola de ${clase.nombre}.`
        : `Tu plaza en ${clase.nombre} quedará libre y pasará automáticamente a la primera persona de la lista de espera.`,
      enEspera ? 'Sí, salir' : 'Sí, darme de baja'
    );
    if (!ok) return;
    inscripciones = inscripciones.filter((i) => !(i.claseId === claseId && i.usuarioId === u.id));
    guardar(ALMACEN.inscripciones, inscripciones);
    if (!enEspera) promocionarCola(clase);
    avisar(enEspera ? 'Has salido de la lista de espera.' : `Baja tramitada en ${clase.nombre}.`);
    pintarClases(); pintarClasesInicio(); pintarMisReservas();
  }

  async function cancelarReserva(id) {
    const u = sesion();
    const r = reservas.find((x) => x.id === id);
    if (!r || !u || r.usuarioId !== u.id) return; // solo la persona titular cancela
    const inst = instPorId(r.instId);
    const ok = await confirmar(
      '¿Cancelar esta reserva?',
      `${inst.nombre} · ${fechaLegible(r.fecha)} a las ${minutosALabel(r.hora)}. La pista quedará libre para otros vecinos.`,
      'Sí, cancelar'
    );
    if (!ok) return;
    reservas = reservas.filter((x) => x.id !== id);
    guardar(ALMACEN.reservas, reservas);
    avisar('Reserva cancelada. ¡Hasta la próxima!');
    pintarMisReservas();
  }

  /* ==========================================================================
     Cuenta: acceso, registro y perfil
     ========================================================================== */

  const fmtFechaLarga = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
  const legibleDia = (clave) => {
    const [a, m, d] = String(clave).split('-').map(Number);
    return fmtFechaLarga.format(new Date(a, m - 1, d));
  };
  const fmtHoraCorta = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  function errorEn(id, mensaje) {
    const campo = $(`#${id}`);
    const error = $(`#error-${id}`);
    if (!campo || !error) return;
    if (mensaje) {
      campo.setAttribute('aria-invalid', 'true');
      error.textContent = mensaje;
      error.hidden = false;
    } else {
      campo.removeAttribute('aria-invalid');
      error.hidden = true;
    }
  }

  function conectarAcceso() {
    const pestanaEntrar = $('#pestana-entrar');
    const pestanaRegistro = $('#pestana-registro');
    const panelEntrar = $('#panel-entrar');
    const panelRegistro = $('#panel-registro');

    const activarPestana = (registro, enfocarPestana) => {
      pestanaEntrar.setAttribute('aria-selected', String(!registro));
      pestanaRegistro.setAttribute('aria-selected', String(registro));
      // Tabindex rotatorio del patrón de pestañas: solo la activa entra por Tab
      pestanaEntrar.tabIndex = registro ? -1 : 0;
      pestanaRegistro.tabIndex = registro ? 0 : -1;
      panelEntrar.hidden = registro;
      panelRegistro.hidden = !registro;
      if (enfocarPestana) (registro ? pestanaRegistro : pestanaEntrar).focus();
    };
    activarPestana(false);
    pestanaEntrar.addEventListener('click', () => activarPestana(false));
    pestanaRegistro.addEventListener('click', () => activarPestana(true));
    // Flechas, Inicio y Fin mueven la selección, como pide el patrón WAI-ARIA
    [pestanaEntrar, pestanaRegistro].forEach((p) => {
      p.addEventListener('keydown', (ev) => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) {
          ev.preventDefault();
          const irARegistro = ev.key === 'End' || (ev.key !== 'Home' && p === pestanaEntrar);
          activarPestana(irARegistro, true);
        }
      });
    });

    const trasAcceso = (nombre) => {
      pintarSesion();
      avisar(`Hola, ${nombre.split(' ')[0]}. Sesión iniciada.`);
      const destino = destinoTrasAcceso || '#/perfil';
      destinoTrasAcceso = null;
      location.hash = destino;
    };

    panelEntrar.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const email = $('#entrar-email').value.trim();
      const clave = $('#entrar-clave').value;
      errorEn('entrar-email', email ? '' : 'Escribe tu correo.');
      errorEn('entrar-clave', clave ? '' : 'Escribe tu contraseña.');
      if (!email || !clave) {
        $(!email ? '#entrar-email' : '#entrar-clave').focus();
        return;
      }
      const res = await MSDAuth.entrar(email, clave);
      if (res.error) {
        // El error se asocia al campo que lo causa (correo inexistente vs contraseña)
        const campo = res.campo === 'email' ? 'entrar-email' : 'entrar-clave';
        errorEn(campo, res.error);
        $(`#${campo}`).focus();
        return;
      }
      trasAcceso(res.usuario.nombre);
    });

    panelRegistro.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const nombre = $('#registro-nombre').value.trim();
      const email = $('#registro-email').value.trim();
      const telefono = $('#registro-telefono').value.trim();
      const clave = $('#registro-clave').value;
      errorEn('registro-nombre', nombre.length >= 3 ? '' : 'Escribe tu nombre y apellidos.');
      errorEn('registro-email', /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? '' : 'Revisa el correo: debe tener el formato nombre@dominio.es.');
      errorEn('registro-telefono', /^(\+34)?[679]\d{8}$/.test(telefono.replace(/[\s.-]/g, '')) ? '' : 'Escribe un móvil válido de 9 cifras.');
      errorEn('registro-clave', clave.length >= 8 ? '' : 'La contraseña debe tener al menos 8 caracteres.');
      if ($$('#panel-registro [aria-invalid="true"]').length) {
        $$('#panel-registro [aria-invalid="true"]')[0].focus();
        return;
      }
      const res = await MSDAuth.registrar({ nombre, email, telefono, clave });
      if (res.error) { errorEn('registro-email', res.error); return; }
      panelRegistro.reset();
      trasAcceso(res.usuario.nombre);
    });
  }

  /* ---------- Panel de monitor: sus clases, sus inscritos, sus colas ---------- */

  const clasesDeMonitor = (u) =>
    CLASES.filter((c) => u.nombre.toLowerCase().includes(c.monitor.toLowerCase()));

  function pintarMonitor() {
    const u = sesion();
    if (!u) return;
    const mias = u.rol === 'admin' ? CLASES : clasesDeMonitor(u);
    const cont = $('#monitor-clases');
    if (!mias.length) {
      cont.innerHTML = `<div class="aviso-vacio"><strong>No tienes clases asignadas</strong>
        La asignación se hace desde el panel de administración (el nombre del monitor de la clase debe coincidir con tu nombre).</div>`;
      return;
    }
    cont.innerHTML = mias.map((clase) => {
      const est = estadoClase(clase);
      const reales = inscripcionesDe(clase.id);
      const inscritosReales = reales.filter((i) => i.estado === 'inscrito');
      const esperasReales = reales.filter((i) => i.estado === 'espera').sort((a, b) => a.desde - b.desde);
      const nombreDe = (id) => {
        const q = MSDAuth.buscarPorId(id);
        return q ? q.nombre : 'Vecino/a';
      };
      return `
        <article class="admin-clase" aria-label="${esc(clase.nombre)}">
          <div class="admin-clase__cima">
            <div>
              <h2 style="font-size:1.2rem;margin:0">${esc(clase.nombre)}</h2>
              <span class="paso__ayuda" style="margin:0">${esc(clase.dias)} · ${esc(clase.hora)} · ${esc(clase.lugar)}</span>
            </div>
            <span class="insignia ${est.libres ? 'insignia--plazas' : 'insignia--llena'}">
              ${est.inscritos}/${clase.aforo}${est.cola ? ` · ${est.cola} en cola` : ''}
            </span>
          </div>
          <div class="aforo">
            <div class="aforo__texto"><span>Ocupación</span><span>${est.inscritos} / ${clase.aforo}</span></div>
            <div class="aforo__barra"><div class="aforo__relleno${est.llena ? ' aforo__relleno--llena' : ''}" style="width:${Math.min(100, Math.round(est.inscritos / clase.aforo * 100))}%"></div></div>
          </div>
          <div class="admin-clase__gente">
            <span class="persona-chip">${icono('i-personas', 14)} ${baseInscritos(clase)} vecinos (histórico)</span>
            ${inscritosReales.map((i) => `<span class="persona-chip">${esc(nombreDe(i.usuarioId))}</span>`).join('')}
            ${baseCola(clase) > 0 ? `<span class="persona-chip persona-chip--espera">${icono('i-cola', 14)} ${baseCola(clase)} esperando (histórico)</span>` : ''}
            ${esperasReales.map((i, idx) => `<span class="persona-chip persona-chip--espera">${idx + 1 + baseCola(clase)}º · ${esc(nombreDe(i.usuarioId))}</span>`).join('')}
          </div>
        </article>`;
    }).join('');
  }

  /* ---------- Perfil ---------- */

  function htmlCarnet(u) {
    const abono = u.abono;
    if (!abono) {
      // Sin actividades no hay QR: interfaz normal, con la puerta abierta a apuntarse
      return `
        <div class="carnet-alta">
          <p><strong>Todavía no estás en ninguna actividad.</strong> Cuando te
          inscribas en una clase, aquí aparecerá tu carnet con su código QR para
          entrar por el torno. Mientras tanto puedes reservar pistas con normalidad.</p>
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:14px">
            <a class="boton boton--primario" href="#/clases">Ver actividades e inscribirme</a>
            <button class="boton boton--secundario" type="button" data-pedir-info>Pedir información</button>
          </div>
          <p class="campo__ayuda" style="margin-top:14px">¿Solo quieres el gimnasio?
            <button class="boton--texto" type="button" data-alta-abono style="color:var(--verde)">Activar abono mensual · ${fmtEur(MSDAuth.PRECIO_ABONO)}</button>
          </p>
        </div>`;
    }

    const vigente = abono.activo && abono.hasta >= MSDAuth.hoy();
    const estado = !abono.activo
      ? '<span class="insignia insignia--llena">De baja</span>'
      : (vigente
        ? `<span class="insignia insignia--plazas">En vigor hasta el ${esc(legibleDia(abono.hasta))}</span>`
        : `<span class="insignia insignia--pocas">Caducado el ${esc(legibleDia(abono.hasta))}</span>`);

    const idAcceso = abono.nfcUid || abono.nfcId || '';

    return `
      <div class="carnet">
        <div class="carnet__tarjeta">
          <div class="carnet__cima">
            <span class="marca__sello" aria-hidden="true"><svg width="22" height="22"><use href="#i-arco"/></svg></span>
            <div>
              <strong>Carnet deportivo</strong>
              <span>Complejo Prado de la Feria</span>
            </div>
          </div>
          <p class="carnet__nombre">${esc(u.nombre)}</p>
          <div class="carnet__qr">
            ${vigente
              ? '<div id="carnet-qr" class="carnet__qr-lienzo" role="img" aria-label="Código QR dinámico del carnet, se renueva cada 30 segundos"><span class="campo__ayuda">Generando código…</span></div>'
              : `<div class="carnet__qr-apagado">${icono('i-info', 26)}<span>QR desactivado</span></div>`}
          </div>
          ${vigente ? '<p class="carnet__caduca">Código dinámico · se renueva en <strong id="carnet-qr-seg">30</strong>&nbsp;s</p>' : ''}
          <p class="carnet__codigo">${esc(idAcceso)}</p>
          ${estado}
        </div>
        <div class="carnet__lado">
          <div class="pulsera ${vigente ? '' : 'pulsera--apagada'}" role="img" aria-label="Pulsera NFC ${esc(idAcceso)}${vigente ? ' activa' : ' desactivada'}">
            <span class="pulsera__chip" aria-hidden="true"></span>
            <span class="pulsera__ondas" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="pulsera__texto">${esc(idAcceso)}</span>
          </div>
          <p class="paso__ayuda">Tu pulsera NFC y tu QR abren el torno del gimnasio mientras el abono esté en vigor. Preséntalos en recepción si pierdes alguno.</p>
          <div class="campo campo--check">
            <input id="perfil-autorenovar" type="checkbox" ${abono.autoRenovar ? 'checked' : ''} ${abono.activo ? '' : 'disabled'}>
            <label for="perfil-autorenovar">Renovación automática mensual (${fmtEur(MSDAuth.PRECIO_ABONO)}/mes).</label>
          </div>
          <div class="carnet__acciones">
            ${vigente ? '<button class="boton boton--secundario" type="button" data-imprimir-carnet>Imprimir carnet</button>' : ''}
            ${abono.activo
              ? `<button class="boton boton--secundario" type="button" data-renovar-abono>Renovar un mes</button>
                 <button class="boton--texto" type="button" data-baja-abono>Dar de baja el abono</button>`
              : `<button class="boton boton--primario" type="button" data-alta-abono>Reactivar abono · ${fmtEur(MSDAuth.PRECIO_ABONO)}</button>`}
          </div>
        </div>
      </div>`;
  }

  /* QR dinámico del carnet: lo pinta y lo refresca cada segundo. El código
     cambia cada 30 s, así que una foto de la pantalla deja de valer enseguida.
     Se detiene solo cuando el carnet desaparece del DOM (cambio de vista). */
  let carnetQrTimer = null;
  async function arrancarQrDinamico(u) {
    clearInterval(carnetQrTimer);
    const cont = $('#carnet-qr');
    if (!cont) return;
    let ultimoPayload = '';
    const tick = async () => {
      if (!document.body.contains(cont)) { clearInterval(carnetQrTimer); return; }
      const usuario = MSDAuth.buscarPorId(u.id) || u;
      const carnet = await MSDAuth.cargaQrDinamica(usuario);
      if (!carnet) return;
      if (carnet.payload !== ultimoPayload) {
        ultimoPayload = carnet.payload;
        cont.innerHTML = MSDQr.comoSvg(carnet.payload);
      }
      const seg = $('#carnet-qr-seg');
      if (seg) seg.textContent = Math.max(0, Math.ceil((carnet.expiraEnMs || 0) / 1000));
    };
    await tick();
    carnetQrTimer = setInterval(tick, 1000);
  }

  function pintarPerfil() {
    const u = sesion();
    if (!u) return;
    const iniciales = u.nombre.split(/\s+/).slice(0, 2).map((p) => p[0] || '').join('').toUpperCase();
    $('#perfil-avatar').textContent = iniciales;
    $('#perfil-email').innerHTML = `${esc(u.email)}${u.rol === 'monitor'
      ? ' · <a href="#/monitor"><strong>Mis clases como monitor</strong></a>' : ''}`;
    $('#perfil-nombre').value = u.nombre;
    $('#perfil-telefono').value = u.telefono || '';
    $('#perfil-abono').innerHTML = htmlCarnet(u);
    arrancarQrDinamico(u); // pinta y refresca el QR rotatorio si el carnet está en vigor

    pintarCampana(); // el badge refleja avisos nuevos (renovaciones, cola…)

    const mios = MSDAuth.accesos().filter((a) => a.usuarioId === u.id).slice(0, 8);
    $('#perfil-accesos').innerHTML = mios.length
      ? `<ul class="lista-accesos">${mios.map((a) => `
          <li>
            <span class="lista-accesos__icono ${a.resultado === 'ok' ? 'ok' : 'mal'}">${icono(a.resultado === 'ok' ? 'i-check' : 'i-x', 15)}</span>
            <span>${esc(fmtHoraCorta.format(new Date(a.ts)))} · ${a.direccion === 'salida' ? 'Salida' : 'Entrada'} · ${a.metodo === 'qr' ? 'QR' : 'Pulsera NFC'}</span>
            <span class="lista-accesos__motivo">${esc(a.motivo)}</span>
          </li>`).join('')}</ul>`
      : `<div class="aviso-vacio"><strong>Sin accesos todavía</strong>Cuando pases el torno con tu QR o pulsera, aparecerán aquí.</div>`;
  }

  function conectarPerfil() {
    $('#boton-salir').addEventListener('click', () => {
      MSDAuth.salir();
      pintarSesion();
      avisar('Sesión cerrada. ¡Hasta pronto!');
      location.hash = '#/';
    });

    $('#form-perfil').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const u = sesion();
      if (!u) return;
      const nombre = $('#perfil-nombre').value.trim();
      const telefono = $('#perfil-telefono').value.trim();
      errorEn('perfil-nombre', nombre.length >= 3 ? '' : 'Escribe tu nombre y apellidos.');
      errorEn('perfil-telefono', telefono === '' || /^(\+34)?[679]\d{8}$/.test(telefono.replace(/[\s.-]/g, '')) ? '' : 'Escribe un móvil válido de 9 cifras.');
      const invalidoPerfil = $('#form-perfil [aria-invalid="true"]');
      if (invalidoPerfil) { invalidoPerfil.focus(); return; }
      MSDAuth.actualizarPerfil(u.id, { nombre, telefono });
      pintarSesion();
      pintarPerfil();
      avisar('Datos guardados.');
    });

    $('#form-clave').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const u = sesion();
      if (!u) return;
      const actual = $('#clave-actual').value;
      const nueva = $('#clave-nueva').value;
      errorEn('clave-actual', actual ? '' : 'Escribe tu contraseña actual.');
      errorEn('clave-nueva', nueva.length >= 8 ? '' : 'La nueva contraseña debe tener al menos 8 caracteres.');
      const invalidoClave = $('#form-clave [aria-invalid="true"]');
      if (invalidoClave) { invalidoClave.focus(); return; }
      const res = await MSDAuth.cambiarClave(u.id, actual, nueva);
      if (res.error) { errorEn('clave-actual', res.error); $('#clave-actual').focus(); return; }
      ev.target.reset();
      avisar('Contraseña actualizada.');
    });

    // Acciones del carnet (delegación dentro del bloque de abono)
    $('#perfil-abono').addEventListener('click', (ev) => {
      const u = sesion();
      if (!u) return;
      if (ev.target.closest('[data-pedir-info]')) {
        MSDAuth.anotarAutomatizacion('solicitudes',
          `${u.nombre} pide información para apuntarse a una actividad (${u.email}${u.telefono ? ' · ' + u.telefono : ''}).`);
        MSDAuth.notificar(u.id, 'Hemos pasado tu solicitud de información a la oficina de deportes: te contactarán en breve.');
        pintarCampana();
        avisar('¡Hecho! La oficina de deportes te contactará para ayudarte a elegir actividad.');
        return;
      }
      if (ev.target.closest('[data-imprimir-carnet]')) {
        // En papel solo sale la tarjeta del carnet (regla @media print)
        document.documentElement.classList.add('solo-carnet');
        const limpiar = () => document.documentElement.classList.remove('solo-carnet');
        window.addEventListener('afterprint', limpiar, { once: true });
        window.print();
        setTimeout(limpiar, 2000); // por si afterprint no llega a dispararse
      } else if (ev.target.closest('[data-alta-abono]')) {
        const auto = $('#alta-autorenovar');
        // Al reactivar, se conserva la preferencia de renovación que ya tenía
        const autoRenovar = auto ? auto.checked : (u.abono ? u.abono.autoRenovar : true);
        MSDAuth.activarAbono(u.id, autoRenovar);
        pintarPerfil();
        avisar('¡Abono activado! Tu carnet QR y tu pulsera ya abren el torno.');
      } else if (ev.target.closest('[data-renovar-abono]')) {
        MSDAuth.renovarAbono(u.id, true);
        pintarPerfil();
        avisar('Abono renovado un mes más.');
      } else if (ev.target.closest('[data-baja-abono]')) {
        confirmar('¿Dar de baja el abono?',
          'El torno dejará de aceptar tu QR y tu pulsera desde ahora. Podrás reactivarlo cuando quieras.',
          'Sí, darlo de baja').then((ok) => {
          if (!ok) return;
          MSDAuth.bajaAbono(sesion().id);
          pintarPerfil();
          avisar('Abono dado de baja.');
        });
      }
    });

    $('#perfil-abono').addEventListener('change', (ev) => {
      if (ev.target.id === 'perfil-autorenovar') {
        const u = sesion();
        if (u) MSDAuth.cambiarAutoRenovar(u.id, ev.target.checked);
      }
    });
  }

  /* ==========================================================================
     Aforo del gimnasio en tiempo real (portada)
     Curva horaria determinista + los accesos reales del torno de hoy.
     ========================================================================== */

  function pintarAforo() {
    const cifra = $('#dato-aforo-cifra');
    if (!cifra) return;
    const ahora = new Date();
    const h = ahora.getHours();
    const dia = ahora.getDay();
    const abierto = h >= 9 && ((dia === 0 || dia === 6) ? h < 21 : h < 23);
    if (!abierto) {
      cifra.textContent = '—';
      $('#dato-aforo-texto').textContent = 'gimnasio cerrado ahora';
      return;
    }
    // Aforo REAL a partir del torno: entradas − salidas de hoy.
    // Con lector de entrada y de salida, esta cifra es exacta, no una estimación.
    const { dentro, entradas, salidas, aforoMax } = MSDAuth.aforoHoy();
    cifra.textContent = `${Math.min(dentro, aforoMax)}/${aforoMax}`;
    $('#dato-aforo-texto').textContent = salidas
      ? `personas ahora en la sala · hoy ${entradas} entradas y ${salidas} salidas`
      : `personas ahora en la sala · ${entradas} entradas hoy`;
  }

  /* ==========================================================================
     Campana de notificaciones
     ========================================================================== */

  const fmtNotif = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  function pintarCampana() {
    const boton = $('#campana');
    const badge = $('#campana-badge');
    const u = sesion();
    if (!u) {
      boton.hidden = true;
      $('#campana-panel').hidden = true;
      boton.setAttribute('aria-expanded', 'false');
      return;
    }
    boton.hidden = false;
    const sinLeer = MSDAuth.notificacionesDe(u.id).filter((n) => !n.leida).length;
    badge.hidden = sinLeer === 0;
    badge.textContent = sinLeer > 9 ? '9+' : String(sinLeer);
    boton.setAttribute('aria-label', sinLeer
      ? `Notificaciones: ${sinLeer} sin leer` : 'Notificaciones');
  }

  function conectarCampana() {
    const boton = $('#campana');
    const panel = $('#campana-panel');

    const cerrar = () => {
      panel.hidden = true;
      boton.setAttribute('aria-expanded', 'false');
    };

    boton.addEventListener('click', () => {
      const u = sesion();
      if (!u) return;
      if (!panel.hidden) { cerrar(); return; }
      const lista = MSDAuth.notificacionesDe(u.id).slice(0, 12);
      $('#campana-lista').innerHTML = lista.length
        ? `<ul class="campana-lista">${lista.map((n) => `
            <li class="${n.leida ? '' : 'sin-leer'}">
              <span class="campana-lista__cuando">${esc(fmtNotif.format(new Date(n.ts)))}</span>
              <span>${esc(n.texto)}</span>
            </li>`).join('')}</ul>`
        : '<p class="campana-vacia">Nada nuevo por aquí. Cuando avance tu cola o cambie tu abono, te avisaremos.</p>';
      panel.hidden = false;
      boton.setAttribute('aria-expanded', 'true');
      MSDAuth.marcarLeidas(u.id);
      pintarCampana();
    });

    document.addEventListener('click', (ev) => {
      if (!panel.hidden && !ev.target.closest('.campana-envoltura')) cerrar();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !panel.hidden) { cerrar(); boton.focus(); }
    });
  }

  /* ==========================================================================
     Buscador de huecos libres (portada)
     ========================================================================== */

  function pintarBuscador() {
    const selDia = $('#buscador-dia');
    const selHora = $('#buscador-hora');
    const previo = selDia.value;
    // Se reconstruye siempre: la ventana de reserva puede cambiar desde el panel
    selDia.innerHTML = diasReservables().map(({ clave }) =>
      `<option value="${esc(clave)}">${esc(fechaLegible(clave))}</option>`).join('');
    if (previo && Array.from(selDia.options).some((o) => o.value === previo)) selDia.value = previo;
    if (!selHora.options.length) {
      for (let h = 9; h <= 21; h++) {
        const opcion = document.createElement('option');
        opcion.value = String(h * 60);
        opcion.textContent = `${pad2(h)}:00`;
        selHora.appendChild(opcion);
      }
      const proxima = Math.min(21, Math.max(9, new Date().getHours() + 1));
      selHora.value = String(proxima * 60);
    }
  }

  function buscarHuecos(ev) {
    ev.preventDefault();
    const fecha = $('#buscador-dia').value;
    const desde = Number($('#buscador-hora').value);
    const huecos = [];
    for (const inst of INSTALACIONES) {
      for (const pista of inst.pistas) {
        const tramo = tramosDe(inst, pista.id, fecha)
          .find((t) => t.estado === 'libre' && t.hora >= desde);
        if (tramo) huecos.push({ inst, pista, tramo });
      }
    }
    const cont = $('#buscador-resultados');
    if (!huecos.length) {
      cont.innerHTML = '<div class="aviso-vacio"><strong>Todo ocupado a esa hora</strong>Prueba con otro día u otra franja.</div>';
      return;
    }
    cont.innerHTML = `
      <p class="buscador__cuenta">${huecos.length} huecos libres el ${esc(fechaLegible(fecha).toLowerCase())}:</p>
      <div class="chips">
        ${huecos.map((h) => `
          <button class="chip chip--hueco" type="button"
                  data-hueco-inst="${h.inst.id}" data-hueco-pista="${h.pista.id}"
                  data-hueco-fecha="${esc(fecha)}" data-hueco-hora="${h.tramo.hora}">
            ${icono(h.inst.icono, 16)} ${esc(h.inst.nombre)} · ${esc(h.pista.nombre)} — ${h.tramo.label}
          </button>`).join('')}
      </div>`;
  }

  /* Mostrar/ocultar contraseñas (el texto visible es el nombre accesible) */
  document.addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-ver-clave]');
    if (!boton) return;
    const campo = $(`#${boton.dataset.verClave}`);
    if (!campo) return;
    const visible = campo.type === 'text';
    campo.type = visible ? 'password' : 'text';
    boton.setAttribute('aria-pressed', String(!visible));
    boton.textContent = visible ? 'Ver' : 'Ocultar';
  });

  /* ==========================================================================
     Añadir al calendario (.ics)
     ========================================================================== */

  function descargarFichero(nombre, contenido, tipo) {
    const blob = new Blob([contenido], { type: tipo });
    const enlace = document.createElement('a');
    enlace.href = URL.createObjectURL(blob);
    enlace.download = nombre;
    enlace.click();
    setTimeout(() => URL.revokeObjectURL(enlace.href), 5000);
  }

  function descargarICS(reserva) {
    const inst = instPorId(reserva.instId);
    const pista = pistaDe(inst, reserva.pistaId);
    const [a, m, d] = reserva.fecha.split('-').map(Number);
    const inicio = new Date(a, m - 1, d, Math.floor(reserva.hora / 60), reserva.hora % 60);
    const fin = new Date(inicio.getTime() + inst.duracionMin * 60000);
    const sello = (x) =>
      `${x.getFullYear()}${pad2(x.getMonth() + 1)}${pad2(x.getDate())}T${pad2(x.getHours())}${pad2(x.getMinutes())}00`;
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Deportes Medina Sidonia//Reservas//ES',
      'BEGIN:VEVENT',
      `UID:${reserva.id}@deportes-medinasidonia`,
      `DTSTAMP:${sello(new Date())}`,
      `DTSTART:${sello(inicio)}`,
      `DTEND:${sello(fin)}`,
      `SUMMARY:${inst.nombre} · ${pista.nombre}`,
      'LOCATION:Complejo Deportivo Prado de la Feria\\, Medina Sidonia',
      `DESCRIPTION:Localizador ${reserva.localizador}. Cancelación gratuita hasta 24 h antes.`,
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');
    descargarFichero(`reserva-${reserva.localizador}.ics`, ics, 'text/calendar;charset=utf-8');
    avisar('Evento descargado: ábrelo para añadirlo a tu calendario.');
  }

  /* ---------- Validación del formulario ---------- */

  const validadores = {
    nombre(valor) {
      return valor.trim().length >= 3 ? '' : 'Escribe tu nombre y apellidos.';
    },
    email(valor) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(valor.trim())
        ? '' : 'Revisa el correo: debe tener el formato nombre@dominio.es.';
    },
    telefono(valor) {
      return /^(\+34)?[679]\d{8}$/.test(valor.replace(/[\s.-]/g, ''))
        ? '' : 'Escribe un móvil válido de 9 cifras (ej.: 600 123 456).';
    },
    normas(marcado) {
      return marcado ? '' : 'Debes aceptar las normas para continuar.';
    }
  };

  function validarCampo(nombreCampo) {
    const campo = $(`#campo-${nombreCampo}`);
    const error = $(`#error-${nombreCampo}`);
    const valor = campo.type === 'checkbox' ? campo.checked : campo.value;
    const mensaje = validadores[nombreCampo](valor);
    if (mensaje) {
      campo.setAttribute('aria-invalid', 'true');
      error.textContent = mensaje;
      error.hidden = false;
    } else {
      campo.removeAttribute('aria-invalid');
      error.hidden = true;
    }
    return !mensaje;
  }

  function conectarFormulario() {
    const form = $('#form-reserva');
    ['nombre', 'email', 'telefono'].forEach((n) => {
      $(`#campo-${n}`).addEventListener('blur', () => {
        const campo = $(`#campo-${n}`);
        if (campo.value.trim() !== '') validarCampo(n);
      });
    });

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const campos = ['nombre', 'email', 'telefono', 'normas'];
      const invalidos = campos.filter((n) => !validarCampo(n));
      if (invalidos.length) {
        $(`#campo-${invalidos[0]}`).focus();
        return;
      }

      const boton = $('#boton-confirmar');
      boton.disabled = true;
      boton.textContent = 'Confirmando…';

      // Pequeña espera simulada, como haría la pasarela real
      setTimeout(async () => {
        const inst = instPorId(seleccion.instId);
        const restaurarBoton = () => {
          boton.disabled = false;
          boton.innerHTML = `${icono('i-check', 18)} Confirmar reserva`;
        };

        // Revalidación en el momento de confirmar: el tramo puede haber
        // pasado de hora o haberse reservado ya (p. ej. volviendo con Atrás).
        const tramo = inst && tramosDe(inst, seleccion.pistaId, seleccion.fecha)
          .find((t) => t.hora === seleccion.hora);
        const fechaPasada = seleccion.fecha < claveDeFecha(new Date());
        const enVentana = diasReservables().some((v) => v.clave === seleccion.fecha);
        if (!inst || fechaPasada || !enVentana || !tramo || tramo.estado !== 'libre') {
          restaurarBoton();
          avisar(!enVentana
            ? 'Las reservas para ese día no están abiertas todavía.'
            : 'Ese tramo ya no está disponible. Elige otra hora, por favor.', 'error');
          seleccion.hora = null;
          location.replace('#/reservar/horario');
          return;
        }

        // La sesión puede haberse cerrado en otra pestaña mientras el formulario seguía abierto
        const quien = sesion();
        if (!quien) {
          restaurarBoton();
          avisar('Tu sesión se ha cerrado. Entra de nuevo para confirmar la reserva.', 'error');
          destinoTrasAcceso = '#/reservar/confirmar';
          location.replace('#/acceso');
          return;
        }

        usuario = {
          nombre: $('#campo-nombre').value.trim(),
          email: $('#campo-email').value.trim(),
          telefono: $('#campo-telefono').value.trim()
        };
        guardar(ALMACEN.usuario, usuario);

        ultimaReserva = {
          id: `r-${Date.now()}`,
          usuarioId: quien.id,
          localizador: `MS-${(Date.now() % 1679616).toString(36).toUpperCase().padStart(4, '0')}${Math.floor(Math.random() * 36).toString(36).toUpperCase()}`,
          instId: seleccion.instId,
          pistaId: seleccion.pistaId,
          fecha: seleccion.fecha,
          hora: seleccion.hora,
          precio: precioDeSeleccion(),
          nombre: usuario.nombre,
          creada: Date.now()
        };
        // Con servidor, la reserva se confirma de forma atómica: si dos personas
        // piden el mismo tramo a la vez, la segunda recibe un aviso claro.
        if (MSDSync.activo) {
          try {
            const respuesta = await fetch(`/api/reservar?cliente=${MSDSync.idCliente}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reserva: ultimaReserva, finMin: seleccion.hora + inst.duracionMin })
            });
            if (respuesta.status === 409) {
              const cuerpo = await respuesta.json().catch(() => ({}));
              restaurarBoton();
              avisar(`${cuerpo.error || 'Esa hora ya está cogida.'} Elige otro hueco, por favor.`, 'error');
              ultimaReserva = null;
              seleccion.hora = null;
              location.replace('#/reservar');
              return;
            }
          } catch (e) { /* sin red: se confirma en local y se sincronizará */ }
        }

        reservas.push(ultimaReserva);
        guardar(ALMACEN.reservas, reservas);
        MSDAuth.notificar(quien.id,
          `Reserva confirmada: ${inst.nombre} el ${fechaLegible(ultimaReserva.fecha).toLowerCase()} a las ${minutosALabel(ultimaReserva.hora)} (${ultimaReserva.localizador}).`);
        pintarCampana();

        restaurarBoton();
        form.reset();
        // La selección se agota al confirmar: volver con Atrás no permite duplicar
        seleccion.reiniciar();
        location.hash = '#/reservar/exito';
      }, 550);
    });
  }

  /* ==========================================================================
     Enrutado
     ========================================================================== */

  const vistas = {
    inicio: $('#vista-inicio'),
    reservar: $('#vista-reservar'),
    clases: $('#vista-clases'),
    mis: $('#vista-mis'),
    acceso: $('#vista-acceso'),
    perfil: $('#vista-perfil'),
    monitor: $('#vista-monitor')
  };

  const pasos = {
    1: $('#paso-parrilla'),
    2: $('#paso-confirmar'),
    exito: $('#paso-exito')
  };

  let primeraCarga = true;

  function mostrarVista(nombre) {
    Object.values(vistas).forEach((v) => { v.hidden = true; });
    vistas[nombre].hidden = false;

    // Estado activo en las navegaciones
    const rutaActiva = {
      inicio: 'inicio', reservar: 'reservar', clases: 'clases',
      mis: 'mis-reservas', acceso: 'perfil', perfil: 'perfil', monitor: 'perfil'
    }[nombre];
    $$('.nav-sup a, .nav-inf a, #chip-usuario').forEach((a) => {
      if (a.dataset.ruta === rutaActiva) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });

    window.scrollTo({ top: 0, behavior: 'auto' });

    // Lleva el foco al título de la vista (lectores de pantalla), salvo en la primera carga
    if (!primeraCarga) {
      const titulo = vistas[nombre].querySelector('h1');
      if (titulo) {
        titulo.setAttribute('tabindex', '-1');
        titulo.focus({ preventScroll: true });
      }
    }
    primeraCarga = false;
  }

  function mostrarPaso(numero) {
    Object.values(pasos).forEach((p) => { p.hidden = true; });
    pasos[numero].hidden = false;

    const indicador = $('#indicador-pasos');
    indicador.hidden = numero === 'exito';
    if (numero !== 'exito') {
      $$('#indicador-pasos li').forEach((li) => {
        const n = Number(li.dataset.paso);
        li.classList.toggle('activo', n === numero);
        li.classList.toggle('hecho', n < numero);
        if (n === numero) li.setAttribute('aria-current', 'step');
        else li.removeAttribute('aria-current');
      });
    }
  }

  function enrutar() {
    // Transición animada entre vistas (como en una app nativa); si el navegador
    // no soporta View Transitions o se pide movimiento reducido, pinta directo.
    const puedeAnimar = !primeraCarga
      && typeof document.startViewTransition === 'function'
      && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (puedeAnimar) {
      const transicion = document.startViewTransition(pintarRuta);
      // Si otra navegación llega antes de acabar, la transición se salta: no es un error
      transicion.finished.catch(() => {});
      transicion.ready.catch(() => {});
    } else {
      pintarRuta();
    }
  }

  function pintarRuta() {
    const hash = location.hash.replace(/^#/, '') || '/';
    if (!hash.startsWith('/')) return; // ancla normal (p. ej. #contenido), no es ruta

    const partes = hash.split('/').filter(Boolean); // p. ej. ['reservar','horario']

    // Si se navega a cualquier vista que no sea el acceso, el destino pendiente caduca
    // (los guards de más abajo lo fijan después de esta línea cuando toca)
    if (partes[0] !== 'acceso') destinoTrasAcceso = null;

    if (partes.length === 0) {
      mostrarVista('inicio');
      pintarInstalaciones($('#inicio-instalaciones'));
      pintarClasesInicio();
      pintarBuscador();
      pintarAforo();
      return;
    }

    switch (partes[0]) {
      case 'reservar': {
        mostrarVista('reservar');
        const sub = partes[1] || '';
        // Los guards usan location.replace para no crear una trampa del botón Atrás
        if (sub === 'horario') {
          location.replace('#/reservar'); // ruta antigua → la parrilla
          return;
        } else if (sub === 'confirmar') {
          if (!seleccion.instId || seleccion.hora == null) { location.replace('#/reservar'); return; }
          if (!sesion()) {
            destinoTrasAcceso = '#/reservar/confirmar';
            const p = $('#acceso-motivo');
            if (p) p.textContent = 'Para confirmar la reserva necesitas tu cuenta. La creas en un minuto y no pierdes tu hueco.';
            location.replace('#/acceso');
            return;
          }
          mostrarPaso(2);
          pintarResumenFinal();
        } else if (sub === 'exito') {
          if (!ultimaReserva) { location.replace('#/reservar'); return; }
          mostrarPaso('exito');
          pintarExito();
          // El anuncio y el foco deben ir a la confirmación, no al h1 de la vista
          const tituloExito = $('#paso-exito h2');
          tituloExito.setAttribute('tabindex', '-1');
          tituloExito.focus({ preventScroll: true });
        } else {
          mostrarPaso(1);
          pintarParrilla();
        }
        break;
      }
      case 'clases':
        mostrarVista('clases');
        pintarClases();
        break;
      case 'mis-reservas':
        mostrarVista('mis');
        pintarMisReservas();
        break;
      case 'acceso': {
        if (sesion()) { location.replace('#/perfil'); return; }
        // Sin destino pendiente, el texto de motivo vuelve al genérico
        if (!destinoTrasAcceso) {
          $('#acceso-motivo').textContent =
            'Con tu cuenta puedes ver la disponibilidad de las pistas, reservar e inscribirte en clases.';
        }
        mostrarVista('acceso');
        break;
      }
      case 'perfil':
        if (!sesion()) { location.replace('#/acceso'); return; }
        mostrarVista('perfil');
        pintarPerfil();
        break;
      case 'monitor': {
        const u = sesion();
        if (!u) { location.replace('#/acceso'); return; }
        if (u.rol !== 'monitor' && u.rol !== 'admin') { location.replace('#/perfil'); return; }
        mostrarVista('monitor');
        pintarMonitor();
        break;
      }
      default:
        location.replace('#/');
    }
  }

  /* ==========================================================================
     Eventos globales (delegación)
     ========================================================================== */

  document.addEventListener('click', (ev) => {
    const objetivo = ev.target.closest('[data-toggle-seccion], [data-celda], [data-inst], [data-pista], [data-dia], [data-semana], [data-hora], [data-accion], [data-filtro], [data-inscribir], [data-cola], [data-baja], [data-cancelar-reserva], [data-noop], [data-hueco-inst], [data-ics], [data-repetir]');
    if (!objetivo) return;

    if (objetivo.dataset.toggleSeccion) {
      const id = objetivo.dataset.toggleSeccion;
      const panel = $(`#horarios-${id}`);
      const abrir = panel.hidden;
      panel.hidden = !abrir;
      objetivo.setAttribute('aria-expanded', String(abrir));
      if (abrir) seccionesAbiertas.add(id);
      else seccionesAbiertas.delete(id);
      return;
    }

    if (objetivo.dataset.celda) {
      // Celda de la parrilla: «tuya» lleva a tus reservas; «libre», a confirmar
      if (objetivo.dataset.estado === 'tuya') {
        location.hash = '#/mis-reservas';
        return;
      }
      seleccionarInstalacion(objetivo.dataset.inst);
      seleccion.pistaId = objetivo.dataset.pista;
      seleccion.fecha = objetivo.dataset.fecha;
      seleccion.hora = Number(objetivo.dataset.hora);
      location.hash = '#/reservar/confirmar';
      return;
    }

    if (objetivo.dataset.huecoInst) {
      // Resultado del buscador: fija toda la selección y va directo a confirmar
      seleccionarInstalacion(objetivo.dataset.huecoInst);
      seleccion.pistaId = objetivo.dataset.huecoPista;
      seleccion.fecha = objetivo.dataset.huecoFecha;
      seleccion.hora = Number(objetivo.dataset.huecoHora);
      location.hash = '#/reservar/confirmar';
      return;
    }

    if (objetivo.dataset.ics) {
      const r = reservas.find((x) => x.id === objetivo.dataset.ics);
      if (r) descargarICS(r);
      return;
    }

    if (objetivo.dataset.repetir) {
      const r = reservas.find((x) => x.id === objetivo.dataset.repetir);
      if (r) {
        seleccionarInstalacion(r.instId);
        seleccion.pistaId = r.pistaId;
        seleccion.fecha = claveDeFecha(new Date());
        seleccion.hora = null;
        location.hash = '#/reservar';
      }
      return;
    }

    if (objetivo.dataset.noop !== undefined) {
      ev.preventDefault();
      avisar('En este prototipo, el documento de normas es de ejemplo.');
      return;
    }

    if (objetivo.dataset.inst) {
      // Tarjeta de instalación: fija la selección antes de navegar al paso 2
      seleccionarInstalacion(objetivo.dataset.inst);
      return; // el enlace ya navega a #/reservar/horario
    }

    if (objetivo.dataset.pista) {
      if (objetivo.dataset.pista !== seleccion.pistaId) {
        seleccion.pistaId = objetivo.dataset.pista;
        seleccion.hora = null;
        pintarPaso2();
        // El re-render destruye el elemento enfocado: se restaura sobre su equivalente
        enfocar(`#selector-pista [data-pista="${seleccion.pistaId}"]`);
      }
      return;
    }

    if (objetivo.dataset.semana) {
      const paso = Number(objetivo.dataset.semana);
      semanaLunes = new Date(semanaLunes.getFullYear(), semanaLunes.getMonth(), semanaLunes.getDate() + paso * 7);
      pintarTiraDias();
      return;
    }

    if (objetivo.dataset.dia) {
      if (objetivo.dataset.dia !== seleccion.fecha) {
        seleccion.fecha = objetivo.dataset.dia;
        seleccion.hora = null;
        pintarParrilla();
        enfocar(`#tira-dias [data-dia="${seleccion.fecha}"]`);
      }
      return;
    }

    if (objetivo.dataset.hora !== undefined && !objetivo.disabled) {
      const hora = Number(objetivo.dataset.hora);
      seleccion.hora = seleccion.hora === hora ? null : hora;
      pintarTramos();
      enfocar(`#malla-horas [data-hora="${hora}"]`);
      return;
    }

    if (objetivo.dataset.filtro) {
      if (objetivo.dataset.filtro !== filtroClases) {
        filtroClases = objetivo.dataset.filtro;
        pintarClases();
        enfocar(`#filtros-clases [data-filtro="${filtroClases}"]`);
      }
      return;
    }

    if (objetivo.dataset.inscribir) { inscribirse(objetivo.dataset.inscribir); return; }
    if (objetivo.dataset.cola) { ponerseEnCola(objetivo.dataset.cola); return; }
    if (objetivo.dataset.baja) { darseDeBaja(objetivo.dataset.baja); return; }
    if (objetivo.dataset.cancelarReserva) { cancelarReserva(objetivo.dataset.cancelarReserva); return; }

    switch (objetivo.dataset.accion) {
      case 'volver-paso-1': location.hash = '#/reservar'; break;
      case 'volver-paso-2': location.hash = '#/reservar'; break;
      case 'ir-confirmar':
        if (seleccion.hora != null) location.hash = '#/reservar/confirmar';
        break;
      case 'nueva-reserva':
        seleccion.reiniciar();
        break;
      case 'ics-ultima':
        if (ultimaReserva) descargarICS(ultimaReserva);
        break;
    }
  });

  /* ==========================================================================
     Arranque
     ========================================================================== */

  // La cabecera gana sombra al hacer scroll, como la barra de una app
  let cabeceraFlotante = false;
  window.addEventListener('scroll', () => {
    const flotante = window.scrollY > 8;
    if (flotante !== cabeceraFlotante) {
      cabeceraFlotante = flotante;
      $('.cabecera').classList.toggle('cabecera--flotante', flotante);
    }
  }, { passive: true });

  // El enlace de salto no debe pasar por el enrutador: foco directo al contenido
  $('.salto').addEventListener('click', (ev) => {
    ev.preventDefault();
    const principal = $('#contenido');
    principal.setAttribute('tabindex', '-1');
    principal.focus();
    principal.scrollIntoView({ block: 'start' });
  });

  conectarFormulario();
  conectarAcceso();
  conectarPerfil();
  conectarCampana();
  $('#form-buscador').addEventListener('submit', buscarHuecos);

  // Cambios llegados de fuera (otra pestaña o, con servidor, otro dispositivo):
  // recarga los almacenes y repinta la vista actual para no perder datos.
  function refrescarDesdeFuera() {
    reservas = saneaReservas(leer(ALMACEN.reservas, []));
    inscripciones = saneaInscripciones(leer(ALMACEN.inscripciones, []));
    ajustesClases = saneaAjustesClases(leer(ALMACEN.ajustes, {}));
    bloqueos = saneaBloqueos(leer('msd_bloqueos', []));
    MSDAuth.recargar();
    pintarSesion();
    enrutar();
  }

  window.addEventListener('storage', (ev) => {
    if (ev.key && ev.key.startsWith('msd_')) refrescarDesdeFuera();
  });

  // Los usuarios y abonos de demostración se crean de forma asíncrona:
  // el enrutado arranca cuando el módulo de cuentas está listo.
  MSDAuth.listo.then(() => {
    pintarSesion();
    window.addEventListener('hashchange', enrutar);
    enrutar();
    MSDSync.escuchar(refrescarDesdeFuera); // eventos en directo del servidor
  });

  // PWA: instalable y usable sin conexión cuando se sirve por http(s)
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* opcional */ });
  }
})();
