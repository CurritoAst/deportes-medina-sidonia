/* ==========================================================================
   Deportes · Medina Sidonia — cliente de la API (ÚNICO lugar con fetch())
   Todas las llamadas al servidor pasan por aquí:
     · cookie de sesión (credentials same-origin) y cabeceras anti-CSRF
       (X-Requested-With: MSD, Content-Type: application/json);
     · errores traducidos a objetos { ok:false, status, error, codigo, campo };
     · 401 → se avisa (la sesión caducó) para que la app vuelva al acceso.
   Sin red: { ok:false, status:0, sinRed:true }.
   ========================================================================== */

const MSDApi = (function () {
  'use strict';

  const oyentes401 = new Set();

  async function api(metodo, ruta, cuerpo) {
    const opciones = {
      method: metodo,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-Requested-With': 'MSD', 'Accept': 'application/json' }
    };
    if (cuerpo !== undefined && metodo !== 'GET' && metodo !== 'HEAD') {
      opciones.headers['Content-Type'] = 'application/json';
      opciones.body = JSON.stringify(cuerpo);
    }
    let res;
    try { res = await fetch(ruta, opciones); }
    catch (e) { return { ok: false, status: 0, sinRed: true, error: 'Sin conexión. Inténtalo de nuevo en un momento.' }; }
    let datos = null;
    if (res.status !== 204) { try { datos = await res.json(); } catch (e) { datos = null; } }
    if (res.ok) return { ok: true, status: res.status, datos: datos || {} };
    const err = {
      ok: false, status: res.status,
      error: (datos && datos.error) || (res.status === 429 ? 'Demasiados intentos. Espera un poco.' : res.status >= 500 ? 'Error del servidor. Inténtalo más tarde.' : 'No se ha podido completar la operación.'),
      codigo: datos && datos.codigo, campo: datos && datos.campo,
      reintentarEn: datos && datos.reintentarEn, datos
    };
    if (res.status === 401) oyentes401.forEach((f) => { try { f(err); } catch (e) { /* */ } });
    return err;
  }

  return {
    api,
    get: (r) => api('GET', r),
    post: (r, c) => api('POST', r, c === undefined ? {} : c),
    patch: (r, c) => api('PATCH', r, c),
    del: (r) => api('DELETE', r),
    al401: (f) => oyentes401.add(f)
  };
})();
