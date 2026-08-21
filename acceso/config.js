/* ==========================================================================
   Servicio de acceso del torno — configuración
   Todo se puede sobreescribir por variables de entorno, así el mismo código
   sirve para desarrollo (lector simulado en localhost) y para producción
   (HF5122 real en 192.168.1.35).
   ========================================================================== */

'use strict';
const path = require('path');

module.exports = {
  // Web de gestión: de aquí se descargan los socios y aquí se registran accesos.
  WEB: process.env.MSD_WEB || 'http://localhost:8137',

  /* Token de servicio del torno (F3): lo genera el admin y se pone igual en la
     web (variable MSD_TOKEN_TORNO del panel Node de Plesk, con prefijo
     'nombre:') y aquí (/etc/acceso-torno.env, solo el token). Sin él, la web
     responde 401 y el torno sigue con su caché. */
  TOKEN: (process.env.MSD_TOKEN_TORNO || '').replace(/^[^:]+:/, '').trim(),
  TIMEOUT_MS: Number(process.env.MSD_TIMEOUT_MS || 8000),   // por petición a la web
  COLA_MAX: 5000,                                          // accesos en cola offline (se descartan los más antiguos)
  /* Hora de gimnasio asignada: 'avisar' (por defecto: el torno da paso a todo el
     complejo y solo anota el aviso) o 'denegar' (solo si se decide expresamente). */
  GYM_MODO: process.env.MSD_GYM_MODO === 'denegar' ? 'denegar' : 'avisar',

  /* Lectores publicados por el HF5122 (convertidor serie→TCP), un puerto por
     sentido. En desarrollo apuntan al lector simulado en localhost; en la
     instalación real el HF5122 está en su red propia con la Pi (10.10.100.x):
       MSD_HOST_ENTRADA=10.10.100.254  MSD_HOST_SALIDA=10.10.100.254
     (comprobado en el pabellón: la Pi tiene IP en la red del router Y en la
     10.10.100.x por el mismo eth0; a los lectores se llega por 10.10.100.254). */
  LECTORES: [
    { direccion: 'entrada', host: process.env.MSD_HOST_ENTRADA || '127.0.0.1', puerto: Number(process.env.MSD_PUERTO_ENTRADA || 8899) },
    { direccion: 'salida',  host: process.env.MSD_HOST_SALIDA  || '127.0.0.1', puerto: Number(process.env.MSD_PUERTO_SALIDA  || 9999) }
  ],

  DEDUP_MS: 2000,             // lecturas idénticas dentro de esta ventana → una sola
  SYNC_MS: 60 * 1000,         // cada cuánto se refresca la caché de socios (con ETag: barato)
  RECONEXION_MS: 3000,        // espera entre reintentos de conexión al lector

  EDAD_MINIMA: 16,            // años

  /* Modo solo-escucha: no dispara relé ni registra accesos, solo imprime lo que
     llega. Útil para validar el parseo con el torno real sin tocar nada.
     Actívalo con  MSD_SOLO_ESCUCHA=1 */
  SOLO_ESCUCHA: process.env.MSD_SOLO_ESCUCHA === '1',

  /* ---------- Relé de apertura y LEDs ----------
     Por defecto SIMULA (no toca hardware). En la instalación se ajusta todo por
     variables de entorno; no hace falta tocar código. Ejemplo típico:
       MSD_GPIO=auto        (autodetecta pinctrl/raspi-gpio; o fíjalo a mano)
       MSD_GPIO_NUM=bcm     (o 'board' si tienes los pines del header físico)
       MSD_RELE_ACTIVO_BAJO=1   (placas de relé Waveshare suelen serlo)
       MSD_PIN_ENTRADA=26  MSD_PIN_SALIDA=20
       MSD_PIN_LED_VERDE=21  MSD_PIN_LED_ROJO=16   (opcionales)
     Prueba de cableado sin tarjetas:  node acceso/acceso.js --test-rele  */
  RELE: {
    backend: process.env.MSD_GPIO || 'sim',           // 'sim'|'pinctrl'|'raspi-gpio'|'sysfs'
    numeracion: process.env.MSD_GPIO_NUM || 'bcm',     // 'bcm'|'board'
    activoBajo: process.env.MSD_RELE_ACTIVO_BAJO === '1',
    pulsoMs: Number(process.env.MSD_PULSO_MS || 600),  // duración del pulso de apertura
    pines: {
      entrada: process.env.MSD_PIN_ENTRADA ? Number(process.env.MSD_PIN_ENTRADA) : 26,
      salida: process.env.MSD_PIN_SALIDA ? Number(process.env.MSD_PIN_SALIDA) : 20,
      ledVerde: process.env.MSD_PIN_LED_VERDE ? Number(process.env.MSD_PIN_LED_VERDE) : null,
      ledRojo: process.env.MSD_PIN_LED_ROJO ? Number(process.env.MSD_PIN_LED_ROJO) : null
    }
  },

  CACHE_FICHERO: process.env.MSD_CACHE || path.join(__dirname, 'cache-socios.json')
};
