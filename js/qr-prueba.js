/* Página de QR de prueba del torno: pinta un QR válido (token dinámico numérico
   real de un socio de demostración) y otro no válido (mismo socio pero con un
   código falso), regenerándolos cada segundo. Reutiliza MSDQr y MSDToken. */
'use strict';

// Datos del carnet de demostración (coinciden con la siembra de la web).
const UID = '1399878112';
const SEED = 'a1b2c3d4e5f60001';

let ultimoOk = '', ultimoMal = '';

async function pintar() {
  // ---- QR válido: token dinámico numérico real ----
  const val = await MSDToken.generar(UID, SEED);
  if (val.payload !== ultimoOk) {
    ultimoOk = val.payload;
    document.getElementById('qr-ok').innerHTML = MSDQr.comoSvg(val.payload, { color: '#1f7a4d' });
    document.getElementById('txt-ok').textContent = val.payload;
  }
  const seg = Math.max(0, Math.ceil(val.expiraEnMs / 1000));
  document.getElementById('seg-ok').textContent = seg;

  // ---- QR no válido: mismo socio pero con código falso (8 ceros) ----
  const malPayload = UID + '00000000';
  if (malPayload !== ultimoMal) {
    ultimoMal = malPayload;
    document.getElementById('qr-mal').innerHTML = MSDQr.comoSvg(malPayload, { color: '#b3261e' });
    document.getElementById('txt-mal').textContent = malPayload;
  }
  document.getElementById('seg-mal').textContent = seg;
}

pintar();
setInterval(pintar, 1000);
