/* ==========================================================================
   Deportes · Medina Sidonia — proyecciones hacia el cliente (LISTAS BLANCAS)
   Nunca se serializa una fila de BD tal cual. Cada vista enumera exactamente
   qué campos salen. Así ningún endpoint puede filtrar por descuido clave_hash,
   qr_seed, tokens o el UID completo de la pulsera.
   ========================================================================== */

'use strict';

const fecha = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)) : null);
const diaTexto = (v) => (v ? String(v).slice(0, 10) : '');   // DATE ya viene como 'YYYY-MM-DD'

/* El propio usuario (GET /api/auth/yo, login, etc.). */
function vistaUsuarioPropio(u, extras) {
  return Object.assign({
    id: u.id,
    nombre: u.nombre,
    email: u.email,
    telefono: u.telefono || '',
    rol: u.rol,
    verificado: !!(u.verificado !== undefined ? u.verificado : u.email_verificado_en),
    debeCambiarClave: !!(u.debeCambiarClave !== undefined ? u.debeCambiarClave : u.debe_cambiar_clave),
    birthdate: diaTexto(u.fechaNacimiento !== undefined ? u.fechaNacimiento : u.fecha_nacimiento),
    abono: null,        // se rellena en F3 (vigencia + últimos 4 del UID)
    gimnasio: null,     // F5
    clases: []          // F5
  }, extras || {});
}

/* Un usuario visto por el ADMIN (lista/detalle). Con UID completo (lo necesita
   para asignar pulseras) pero nunca hash ni seed. */
function vistaUsuarioAdmin(u) {
  return {
    id: u.id,
    nombre: u.nombre,
    email: u.email,
    telefono: u.telefono || '',
    rol: u.rol,
    verificado: !!u.email_verificado_en,
    debeCambiarClave: !!u.debe_cambiar_clave,
    birthdate: diaTexto(u.fecha_nacimiento),
    bloqueadoHasta: fecha(u.bloqueado_hasta),
    creado: fecha(u.creado_en),
    ultimoLogin: fecha(u.ultimo_login_en),
    eliminado: !!u.eliminado_en
  };
}

/* Comprueba que un objeto serializable NO contiene campos prohibidos (test). */
const PROHIBIDOS = ['clave_hash', 'claveHash', 'qr_seed', 'qrSeed', 'token_hash', 'tokenHash', 'sal', 'hash'];
function contieneSecretos(obj) {
  const json = JSON.stringify(obj);
  return PROHIBIDOS.some((p) => json.includes(`"${p}"`));
}

module.exports = { vistaUsuarioPropio, vistaUsuarioAdmin, contieneSecretos, PROHIBIDOS };
