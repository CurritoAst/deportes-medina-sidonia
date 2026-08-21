/* ==========================================================================
   Deportes · Medina Sidonia — fechas en la zona del complejo (Europe/Madrid)
   Regla del proyecto:
     · Los DÍAS de negocio (fecha de una reserva, vigencia de un abono, "hoy")
       son días de Europe/Madrid y se guardan como DATE 'YYYY-MM-DD'.
     · Los INSTANTES (ts de un acceso, creado_en…) son epoch UTC / DATETIME UTC.
   Node y MariaDB pueden estar en UTC: por eso el día se calcula AQUÍ con Intl
   y se pasa ya formateado a la BD, nunca con NOW()/CURDATE() de MySQL.
   ========================================================================== */

'use strict';

const ZONA = process.env.MSD_TZ || 'Europe/Madrid';

const fmtPartes = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short'
});

/* Partes locales de un instante: { year, month, day, hour, minute, second, weekday } */
function partes(d) {
  const p = {};
  fmtPartes.formatToParts(d instanceof Date ? d : new Date(d)).forEach((x) => { p[x.type] = x.value; });
  if (p.hour === '24') p.hour = '00';   // algunos motores devuelven 24 a medianoche
  return p;
}

/* 'YYYY-MM-DD' del día de Madrid en ese instante (por defecto ahora). */
function claveDia(d) {
  const p = partes(d || new Date());
  return `${p.year}-${p.month}-${p.day}`;
}
const hoy = () => claveDia(new Date());

/* 'HH:MM:SS' de Madrid en ese instante (para logs). */
function horaTexto(d) {
  const p = partes(d || new Date());
  return `${p.hour}:${p.minute}:${p.second}`;
}

/* Minutos desde medianoche (Madrid) de un instante. */
function minutosDelDia(d) {
  const p = partes(d || new Date());
  return Number(p.hour) * 60 + Number(p.minute);
}

/* Día de la semana en Madrid: 0=domingo … 6=sábado (como Date.getDay()). */
function diaSemana(d) {
  const p = partes(d || new Date());
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
}

/* ¿Es 'YYYY-MM-DD' válido (existe ese día)? */
function esClaveDia(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, dd] = s.split('-').map(Number);
  if (m < 1 || m > 12 || dd < 1 || dd > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, dd));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === dd;
}

/* Suma días a una clave 'YYYY-MM-DD' (aritmética de calendario, sin zonas). */
function sumarDias(clave, n) {
  const [y, m, d] = clave.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/* Suma meses a una clave; si el día no existe en el mes destino, se ajusta al
   último día (31 ene + 1 mes = 28/29 feb), como hace el abono al renovar. */
function sumarMeses(clave, n) {
  const [y, m, d] = clave.split('-').map(Number);
  const primero = new Date(Date.UTC(y, m - 1 + n, 1));
  const ultimoDia = new Date(Date.UTC(primero.getUTCFullYear(), primero.getUTCMonth() + 1, 0)).getUTCDate();
  const dia = Math.min(d, ultimoDia);
  return new Date(Date.UTC(primero.getUTCFullYear(), primero.getUTCMonth(), dia)).toISOString().slice(0, 10);
}

/* Edad cumplida a día de hoy (Madrid) a partir de 'YYYY-MM-DD'; null si no hay fecha. */
function edad(fechaNacimiento, enDia) {
  if (!esClaveDia(fechaNacimiento)) return null;
  const [y, m, d] = fechaNacimiento.split('-').map(Number);
  const [hy, hm, hd] = (enDia || hoy()).split('-').map(Number);
  let e = hy - y;
  if (hm < m || (hm === m && hd < d)) e -= 1;
  return e;
}

/* Comparación de claves 'YYYY-MM-DD' (orden lexicográfico = cronológico). */
const compararDias = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

module.exports = { ZONA, partes, claveDia, hoy, horaTexto, minutosDelDia, diaSemana, esClaveDia, sumarDias, sumarMeses, edad, compararDias };
