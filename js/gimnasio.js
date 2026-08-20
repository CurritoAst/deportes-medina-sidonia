/* ==========================================================================
   Deportes · Medina Sidonia — Gimnasio por horas
   El gimnasio se divide en FRANJAS de 1 hora. Cada franja admite un número fijo
   de personas (capacidad, por defecto 20). Cada socio tiene UNA hora asignada
   (recurrente) y va siempre a esa. Si su franja está llena, entra en la LISTA DE
   ESPERA de esa franja; asciende solo en cuanto se libera un hueco.

   El alta la hace el ADMIN en persona (el socio acude físicamente y el admin
   valora su estado antes de apuntarlo). Solo socios con abono en vigor.

   Estado guardado en la clave `msd_gimnasio` (se sincroniza como el resto). El
   estado asignado/espera NO se guarda: se calcula por antigüedad, así la
   promoción de la cola es automática. Config editable en `msd_gimnasio_cfg`.
   ========================================================================== */

const MSDGimnasio = (function () {
  'use strict';

  const CLAVE = 'msd_gimnasio';
  const CLAVE_CFG = 'msd_gimnasio_cfg';
  const CAP_DEF = 20;
  // Franjas por defecto: como el complejo (09:00–22:00), en tramos de 1 h.
  const FRANJAS_DEF = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00',
    '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00'];

  const empujar = (clave) => { if (typeof MSDSync !== 'undefined') MSDSync.empujar(clave); };

  function leer() {
    try {
      const d = JSON.parse(localStorage.getItem(CLAVE) || '{}');
      return Array.isArray(d.inscripciones) ? d.inscripciones : [];
    } catch (e) { return []; }
  }
  function guardar(inscripciones) {
    localStorage.setItem(CLAVE, JSON.stringify({ inscripciones }));
    empujar(CLAVE);
  }

  function config() {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(CLAVE_CFG) || '{}'); } catch (e) { c = {}; }
    return {
      franjas: (Array.isArray(c.franjas) && c.franjas.length) ? c.franjas : FRANJAS_DEF,
      capacidad: (Number(c.capacidad) > 0) ? Number(c.capacidad) : CAP_DEF
    };
  }
  function guardarConfig(cfg) {
    localStorage.setItem(CLAVE_CFG, JSON.stringify({
      franjas: (Array.isArray(cfg.franjas) && cfg.franjas.length) ? cfg.franjas : FRANJAS_DEF,
      capacidad: (Number(cfg.capacidad) > 0) ? Number(cfg.capacidad) : CAP_DEF
    }));
    empujar(CLAVE_CFG);
  }

  /* Etiqueta legible de una franja: '10:00' → '10:00–11:00'. */
  function etiqueta(franja) {
    const h = parseInt(franja, 10);
    const fin = String((h + 1) % 24).padStart(2, '0') + ':00';
    return `${franja}–${fin}`;
  }

  /* Inscripciones de una franja, por antigüedad, con estado calculado. */
  function deFranja(franja) {
    const cap = config().capacidad;
    return leer()
      .filter((i) => i.franja === franja)
      .sort((a, b) => a.desde - b.desde)
      .map((i, idx) => ({
        ...i,
        estado: idx < cap ? 'asignado' : 'espera',
        posicion: idx < cap ? null : (idx - cap + 1)
      }));
  }

  function ocupacion(franja) {
    const cap = config().capacidad;
    const n = leer().filter((i) => i.franja === franja).length;
    return { asignados: Math.min(n, cap), espera: Math.max(0, n - cap), capacidad: cap, total: n };
  }

  /* Inscripción de un socio (con su estado), o null si no está apuntado. */
  function deUsuario(usuarioId) {
    const i = leer().find((x) => x.usuarioId === usuarioId);
    if (!i) return null;
    return deFranja(i.franja).find((x) => x.id === i.id) || null;
  }

  /* Apunta a un socio a una franja. requisitoOk decide si tiene abono en vigor:
     lo comprueba quien llama (el admin) y lo pasa ya validado. Devuelve
     { ok, estado } o { error }. */
  function apuntar(usuarioId, franja, nota) {
    const franjas = config().franjas;
    if (!franjas.includes(franja)) return { error: 'Esa franja horaria no existe.' };
    const insc = leer();
    if (insc.some((i) => i.usuarioId === usuarioId)) {
      return { error: 'Este socio ya tiene una hora de gimnasio asignada. Muévelo o quítalo primero.' };
    }
    const id = 'g-' + Math.random().toString(36).slice(2, 9);
    insc.push({ id, usuarioId, franja, desde: Date.now(), nota: String(nota || '').slice(0, 200) });
    guardar(insc);
    const est = deUsuario(usuarioId);
    return { ok: true, estado: est ? est.estado : 'asignado' };
  }

  /* Mueve a un socio a otra franja (queda al final de la nueva). */
  function mover(id, nuevaFranja) {
    if (!config().franjas.includes(nuevaFranja)) return { error: 'Franja no válida.' };
    const insc = leer();
    const i = insc.find((x) => x.id === id);
    if (!i) return { error: 'Inscripción no encontrada.' };
    i.franja = nuevaFranja;
    i.desde = Date.now();
    guardar(insc);
    return { ok: true };
  }

  function editarNota(id, nota) {
    const insc = leer();
    const i = insc.find((x) => x.id === id);
    if (!i) return { error: 'No encontrada.' };
    i.nota = String(nota || '').slice(0, 200);
    guardar(insc);
    return { ok: true };
  }

  function quitar(id) {
    guardar(leer().filter((i) => i.id !== id));
    return { ok: true };
  }

  /* Totales para el panel: apuntados, en espera, plazas libres. */
  function resumen() {
    const { franjas, capacidad } = config();
    let asignados = 0, espera = 0;
    for (const f of franjas) {
      const o = ocupacion(f);
      asignados += o.asignados;
      espera += o.espera;
    }
    return { franjas: franjas.length, plazas: franjas.length * capacidad, asignados, espera, libres: franjas.length * capacidad - asignados };
  }

  return {
    config, guardarConfig, etiqueta, deFranja, ocupacion, deUsuario,
    apuntar, mover, editarNota, quitar, resumen, leer
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MSDGimnasio;
