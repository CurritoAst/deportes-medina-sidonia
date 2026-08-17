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

  /* Lectores publicados por el HF5122 (convertidor serie→TCP), un puerto por
     sentido. En desarrollo apuntan al lector simulado en localhost; en la
     instalación real:  MSD_HOST_ENTRADA=192.168.1.35  MSD_HOST_SALIDA=192.168.1.35 */
  LECTORES: [
    { direccion: 'entrada', host: process.env.MSD_HOST_ENTRADA || '127.0.0.1', puerto: Number(process.env.MSD_PUERTO_ENTRADA || 8899) },
    { direccion: 'salida',  host: process.env.MSD_HOST_SALIDA  || '127.0.0.1', puerto: Number(process.env.MSD_PUERTO_SALIDA  || 9999) }
  ],

  DEDUP_MS: 2000,             // lecturas idénticas dentro de esta ventana → una sola
  SYNC_MS: 2 * 60 * 1000,     // cada cuánto se refresca la caché de socios
  RECONEXION_MS: 3000,        // espera entre reintentos de conexión al lector
  PULSO_RELE_MS: 600,         // duración del pulso de apertura

  EDAD_MINIMA: 16,            // años

  /* Modo solo-escucha: no dispara relé ni registra accesos, solo imprime lo que
     llega. Útil para validar el parseo con el torno real sin tocar nada.
     Actívalo con  MSD_SOLO_ESCUCHA=1 */
  SOLO_ESCUCHA: process.env.MSD_SOLO_ESCUCHA === '1',

  /* Relé: por defecto SIMULA (imprime por consola, no toca GPIO). Para disparar
     el relé real en la Raspberry:  MSD_RELE=gpio  (requiere la utilidad pinctrl). */
  SIMULAR_RELE: process.env.MSD_RELE !== 'gpio',
  // Pines GPIO (numeración BCM). Ajústalos a tu HAT de relés antes de usar 'gpio'.
  PINES: { entrada: 26, salida: 20, ledVerde: 21, ledRojo: 16 },

  CACHE_FICHERO: process.env.MSD_CACHE || path.join(__dirname, 'cache-socios.json')
};
