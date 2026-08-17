/* ==========================================================================
   Deportes · Medina Sidonia — sincronización con el servidor
   Si la web se sirve desde server.js, los almacenes msd_* se comparten entre
   dispositivos: al arrancar se descargan, cada guardado se sube, y los
   cambios de otros dispositivos llegan en directo por SSE.
   Abierta con doble clic (file://) funciona igual, solo en local.
   ========================================================================== */

const MSDSync = (function () {
  'use strict';

  const activo = location.protocol === 'http:' || location.protocol === 'https:';
  const idCliente = `c-${Math.random().toString(36).slice(2, 10)}`;

  /* La sesión y la precarga del formulario son de cada dispositivo */
  const LOCALES = new Set(['msd_sesion', 'msd_usuario']);

  let servidorDisponible = false;

  async function arrancar() {
    if (!activo) return false;
    try {
      const res = await fetch('/api/estado', { cache: 'no-store' });
      if (!res.ok) return false;
      const estado = await res.json();
      for (const [clave, valor] of Object.entries(estado)) {
        if (LOCALES.has(clave) || typeof valor !== 'string') continue;
        try { localStorage.setItem(clave, valor); } catch (e) { /* cuota llena */ }
      }
      servidorDisponible = true;
      // Volcado inicial: lo que este dispositivo ya tenía y el servidor no
      for (let i = 0; i < localStorage.length; i++) {
        const clave = localStorage.key(i);
        if (clave && clave.startsWith('msd_') && !LOCALES.has(clave) && !(clave in estado)) {
          empujar(clave);
        }
      }
      return true;
    } catch (e) {
      return false; // servido por otro estático sin API: modo solo local
    }
  }

  function empujar(clave) {
    if (!servidorDisponible || LOCALES.has(clave)) return;
    const valor = localStorage.getItem(clave);
    if (valor === null) return;
    fetch(`/api/estado/${encodeURIComponent(clave)}?cliente=${idCliente}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: valor
    }).catch(() => { /* sin red: seguirá en local */ });
  }

  /* Cambios llegados de otros dispositivos; ignora el eco de los propios */
  function escuchar(alCambiar) {
    if (!servidorDisponible || !window.EventSource) return;
    const fuente = new EventSource('/api/eventos');
    fuente.onmessage = (ev) => {
      let datos;
      try { datos = JSON.parse(ev.data); } catch (e) { return; }
      if (!datos || datos.cliente === idCliente) return;
      if (LOCALES.has(datos.clave) || typeof datos.valor !== 'string') return;
      try { localStorage.setItem(datos.clave, datos.valor); } catch (e) { return; }
      alCambiar(datos.clave);
    };
  }

  return {
    get activo() { return servidorDisponible; },
    get idCliente() { return idCliente; },
    arrancar,
    empujar,
    escuchar
  };
})();
