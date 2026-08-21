/* ==========================================================================
   Deportes · Medina Sidonia — contraseñas (hash y verificación)
   scrypt nativo de Node (sin módulos compilados). Parámetros vigentes:
   N=2^15, r=8, p=3, 32 bytes, sal 16 B → ≈150 ms y 32 MiB por hash.
   Formato guardado (tipo PHC): scrypt$<log2N>$<r>$<p>$<sal b64url>$<hash b64url>
   Como el string lleva los parámetros, se pueden cambiar sin migrar nada:
   verificar() devuelve rehash=true cuando el hash guardado usa otros, y el
   login lo rehace en ese momento.

   Semáforo: scrypt corre en el threadpool; para que un aluvión de logins no
   agote la memoria (32 MiB cada uno) se limita a 3 en vuelo y 50 en cola.
   ========================================================================== */

'use strict';

const crypto = require('crypto');

const PARAMS = { log2N: 15, r: 8, p: 3, largo: 32, sal: 16 };
const MAXMEM = 64 * 1024 * 1024;
const MAX_EN_VUELO = 3;
const MAX_COLA = 50;

let enVuelo = 0;
const cola = [];

function adquirir() {
  return new Promise((resolve, reject) => {
    if (enVuelo < MAX_EN_VUELO) { enVuelo++; return resolve(); }
    if (cola.length >= MAX_COLA) return reject(Object.assign(new Error('ocupado'), { codigo: 'OCUPADO' }));
    cola.push(resolve);
  });
}
function liberar() {
  const siguiente = cola.shift();
  if (siguiente) siguiente(); else enVuelo--;
}

function scrypt(clave, sal, log2N, r, p, largo) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(Buffer.from(String(clave), 'utf8'), sal, largo, { N: 2 ** log2N, r, p, maxmem: MAXMEM }, (e, k) => (e ? reject(e) : resolve(k)));
  });
}

/* Devuelve el string a guardar en usuarios.clave_hash. */
async function hashear(clave) {
  await adquirir();
  try {
    const sal = crypto.randomBytes(PARAMS.sal);
    const k = await scrypt(clave, sal, PARAMS.log2N, PARAMS.r, PARAMS.p, PARAMS.largo);
    return `scrypt$${PARAMS.log2N}$${PARAMS.r}$${PARAMS.p}$${sal.toString('base64url')}$${k.toString('base64url')}`;
  } finally { liberar(); }
}

function parsear(guardado) {
  const partes = String(guardado || '').split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return null;
  const [, log2N, r, p, salB64, hashB64] = partes;
  const n = Number(log2N), rr = Number(r), pp = Number(p);
  if (![n, rr, pp].every(Number.isInteger) || n < 10 || n > 20 || rr < 1 || rr > 32 || pp < 1 || pp > 16) return null;
  const sal = Buffer.from(salB64, 'base64url');
  const hash = Buffer.from(hashB64, 'base64url');
  if (!sal.length || !hash.length) return null;
  return { log2N: n, r: rr, p: pp, sal, hash };
}

/* { ok, rehash }. Nunca lanza por formato raro: devuelve ok=false. */
async function verificar(clave, guardado) {
  const g = parsear(guardado);
  if (!g) return { ok: false, rehash: false };
  await adquirir();
  try {
    const k = await scrypt(clave, g.sal, g.log2N, g.r, g.p, g.hash.length);
    const ok = k.length === g.hash.length && crypto.timingSafeEqual(k, g.hash);
    const rehash = ok && (g.log2N !== PARAMS.log2N || g.r !== PARAMS.r || g.p !== PARAMS.p);
    return { ok, rehash };
  } finally { liberar(); }
}

/* Hash "dummy" para igualar tiempos cuando el email no existe (anti-enumeración). */
let dummyPromesa = null;
function hashDummy() {
  if (!dummyPromesa) dummyPromesa = hashear(crypto.randomBytes(16).toString('hex'));
  return dummyPromesa;
}

/* Política de contraseñas: 10-128 caracteres; que no contenga el nombre ni la
   parte local del correo; que no esté en la lista de las más comunes. */
const COMUNES = new Set(['contraseña','contrasena','password','12345678','123456789','1234567890','qwertyuiop','qwerty1234','iloveyou1',
  'password1','password123','admin1234','administrador','deportes2026','medinasidonia','medina2026','pabellon2026','gimnasio2026',
  'futbol1234','baloncesto','abcdefghij','0123456789','111111111','000000000','asdfghjkl','zxcvbnm123','bienvenido','bienvenida',
  'hola123456','hola1234567','usuario123','prueba1234','test123456','letmein123','welcome123','monkey1234','dragon1234','master1234',
  'sevilla2026','cadiz2026','andalucia','españa2026','espana2026','realmadrid','barcelona1','betis12345','sevillafc1','atletico1']);

function politicaClave(clave, { nombre, email } = {}) {
  if (typeof clave !== 'string') return 'La contraseña no es válida.';
  if (clave.length < 10) return 'La contraseña debe tener al menos 10 caracteres.';
  if (clave.length > 128) return 'La contraseña es demasiado larga (máximo 128).';
  const baja = clave.toLowerCase();
  if (COMUNES.has(baja)) return 'Esa contraseña es demasiado común; elige otra.';
  if (email) {
    const local = String(email).toLowerCase().split('@')[0];
    if (local.length >= 4 && baja.includes(local)) return 'La contraseña no puede contener tu correo.';
  }
  if (nombre) {
    for (const trozo of String(nombre).toLowerCase().split(/\s+/)) {
      if (trozo.length >= 4 && baja.includes(trozo)) return 'La contraseña no puede contener tu nombre.';
    }
  }
  return null;
}

module.exports = { hashear, verificar, parsear, hashDummy, politicaClave, PARAMS };
