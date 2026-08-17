/* ==========================================================================
   Deportes · Medina Sidonia — barra de modo demo
   Para presentar sin teclear contraseñas: cambio de rol en un toque y
   reinicio de los datos en otro. Discreta, accesible y presente en las dos
   páginas. En producción este fichero simplemente no se despliega.
   ========================================================================== */

(function () {
  'use strict';

  const barra = document.createElement('div');
  barra.className = 'demo-barra';
  barra.innerHTML = `
    <button type="button" class="demo-barra__boton" aria-expanded="false" aria-controls="demo-menu">
      Modo demo
    </button>
    <div class="demo-barra__menu" id="demo-menu" hidden>
      <p class="demo-barra__titulo">Cambiar de papel</p>
      <button type="button" data-demo-rol="vecina">Vecina — Carmen</button>
      <button type="button" data-demo-rol="monitora">Monitora — Lucía</button>
      <button type="button" data-demo-rol="tecnico">Técnico de deportes</button>
      <button type="button" data-demo-rol="delegacion">Delegación (PLID)</button>
      <hr>
      <button type="button" data-demo-reiniciar>Reiniciar los datos de la demo</button>
    </div>`;
  document.body.appendChild(barra);

  const boton = barra.querySelector('.demo-barra__boton');
  const menu = barra.querySelector('.demo-barra__menu');

  const cerrar = () => { menu.hidden = true; boton.setAttribute('aria-expanded', 'false'); };
  boton.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    boton.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (ev) => {
    if (!menu.hidden && !ev.target.closest('.demo-barra')) cerrar();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !menu.hidden) { cerrar(); boton.focus(); }
  });

  barra.addEventListener('click', async (ev) => {
    const rol = ev.target.closest('[data-demo-rol]');
    if (rol) {
      await MSDAuth.listo;
      if (rol.dataset.demoRol === 'monitora') {
        MSDAuth.entrarDemo('lucia@correo.es');
        location.href = 'index.html#/monitor';
        location.reload();
        return;
      }
      if (rol.dataset.demoRol === 'vecina') {
        MSDAuth.entrarDemo('carmen@correo.es');
        location.href = 'index.html#/reservar';
        location.reload();
      } else {
        MSDAuth.entrarDemo('admin@medinasidonia.es');
        const destino = rol.dataset.demoRol === 'delegacion' ? 'admin.html#plid' : 'admin.html';
        if (location.pathname.endsWith('admin.html')) { location.hash = ''; location.reload(); }
        else location.href = destino;
      }
      return;
    }
    if (ev.target.closest('[data-demo-reiniciar]')) {
      cerrar();
      if (!window.confirm('¿Devolver la demo a su estado inicial? Se borran reservas, cuentas nuevas y bloqueos.')) return;
      try { await fetch('/api/reiniciar', { method: 'POST' }); } catch (e) { /* modo local */ }
      Object.keys(localStorage)
        .filter((k) => k.startsWith('msd_'))
        .forEach((k) => localStorage.removeItem(k));
      location.reload();
    }
  });
})();
