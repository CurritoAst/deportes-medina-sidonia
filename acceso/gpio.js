/* ==========================================================================
   Deportes · Medina Sidonia — capa GPIO del servicio de acceso
   Dispara relés y LEDs de forma configurable, sin depender de un único método.
   Se ajusta TODO por variables de entorno (ver config.js), así en la instalación
   solo hay que poner valores, no tocar código.

   Backends soportados:
     - 'sim'        : no toca hardware (por defecto). Solo para desarrollo.
     - 'pinctrl'    : Raspberry Pi OS reciente (Bookworm+).
     - 'raspi-gpio' : Raspberry Pi OS antiguo (Buster; el de la imagen del torno).
     - 'sysfs'      : universal (/sys/class/gpio). Requiere root; deprecado pero
                      funciona en kernels antiguos.

   Numeración: 'bcm' (la de pinctrl/raspi-gpio/sysfs) o 'board' (pin físico del
   header; el sistema de Sporttia usaba BOARD). Con 'board' se convierte a BCM.

   Polaridad: activoBajo=true → "relé activado" = pin en BAJO (típico en placas
   de relé Waveshare). activoBajo=false → activado = pin en ALTO.
   ========================================================================== */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');

/* Pin físico del header (BOARD) → GPIO BCM, para la Raspberry de 40 pines. */
const BOARD_A_BCM = {
  3: 2, 5: 3, 7: 4, 8: 14, 10: 15, 11: 17, 12: 18, 13: 27, 15: 22, 16: 23,
  18: 24, 19: 10, 21: 9, 22: 25, 23: 11, 24: 8, 26: 7, 27: 0, 28: 1, 29: 5,
  31: 6, 32: 12, 33: 13, 35: 19, 36: 16, 37: 26, 38: 20, 40: 21
};

/* Detecta qué herramienta GPIO hay en el sistema: pinctrl (Pi OS reciente,
   Bookworm/Trixie), raspi-gpio (Pi OS antiguo) o, si no hay ninguna, 'sim'. */
function detectarBackend() {
  for (const b of ['pinctrl', 'raspi-gpio']) {
    try { execFileSync(b, ['get'], { stdio: 'ignore' }); return b; }
    catch (e) { /* no instalado o falló: probamos el siguiente */ }
  }
  return 'sim';
}

function crearGpio(opciones) {
  let backend = (opciones && opciones.backend) || 'sim';
  if (backend === 'auto') {
    backend = detectarBackend();
    console.log(`[GPIO] backend autodetectado: '${backend}'`);
  }
  const activoBajo = !!(opciones && opciones.activoBajo);
  const numeracion = ((opciones && opciones.numeracion) || 'bcm').toLowerCase();
  let averiado = false;

  const aBcm = (pin) => {
    if (numeracion === 'board') {
      const b = BOARD_A_BCM[pin];
      if (b === undefined) throw new Error(`pin BOARD ${pin} no es un GPIO válido`);
      return b;
    }
    return pin;
  };

  // Nivel físico (0/1) para un estado lógico "activo".
  const nivel = (activo) => {
    const on = activoBajo ? 0 : 1;
    return activo ? on : (1 - on);
  };

  const exportado = new Set();
  function sysfsPreparar(bcm) {
    if (!exportado.has(bcm)) {
      if (!fs.existsSync(`/sys/class/gpio/gpio${bcm}`)) {
        fs.writeFileSync('/sys/class/gpio/export', String(bcm));
      }
      fs.writeFileSync(`/sys/class/gpio/gpio${bcm}/direction`, 'out');
      exportado.add(bcm);
    }
  }

  function escribirFisico(bcm, valor) {
    switch (backend) {
      case 'pinctrl':
        execFileSync('pinctrl', ['set', String(bcm), 'op', valor ? 'dh' : 'dl'], { stdio: 'ignore' });
        break;
      case 'raspi-gpio':
        execFileSync('raspi-gpio', ['set', String(bcm), 'op', valor ? 'dh' : 'dl'], { stdio: 'ignore' });
        break;
      case 'sysfs':
        sysfsPreparar(bcm);
        fs.writeFileSync(`/sys/class/gpio/gpio${bcm}/value`, valor ? '1' : '0');
        break;
      default:
        break; // sim
    }
  }

  /* Fija un pin al estado lógico dado (true = relé/LED activado). */
  function fijar(pin, activo) {
    if (backend === 'sim' || averiado || pin === null || pin === undefined) return;
    try {
      escribirFisico(aBcm(pin), nivel(activo));
    } catch (e) {
      averiado = true;
      console.log(`[GPIO] backend '${backend}' no disponible (${e.message}). Se continúa en modo simulado.`);
    }
  }

  /* Pulso: activa, espera ms, desactiva. */
  async function pulso(pin, ms) {
    if (backend === 'sim' || pin === null || pin === undefined) return false;
    fijar(pin, true);
    await new Promise((r) => setTimeout(r, ms));
    fijar(pin, false);
    return !averiado;
  }

  /* Deja todos los pines como salida y desactivados (estado seguro al arrancar). */
  function inicializar(pines) {
    if (backend === 'sim') return;
    for (const p of pines) fijar(p, false);
  }

  return {
    backend, activoBajo, numeracion,
    fijar, pulso, inicializar,
    get averiado() { return averiado; }
  };
}

module.exports = crearGpio;
