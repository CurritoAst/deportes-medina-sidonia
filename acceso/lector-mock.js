/* ==========================================================================
   Lector de torno SIMULADO — para desarrollo sin hardware.
   Imita al HF5122: abre dos servidores TCP (entrada 8899, salida 9999) y, como
   el lector real, ENVÍA el identificador en texto a quien esté conectado
   (el servicio acceso.js). Emite cada pase por NFC dos veces, para probar la
   deduplicación.

   Uso:
     node acceso/lector-mock.js            # interactivo (teclea comandos)
     node acceso/lector-mock.js auto       # emite una secuencia de prueba y sale

   Comandos interactivos:
     e <uid>     envía un UID por el lector de ENTRADA (dos veces, como el real)
     s <uid>     envía un UID por el lector de SALIDA
     qe <socio>  envía el QR dinámico de un socio por ENTRADA (carmen|paco|lucia)
     qs <socio>  igual pero por SALIDA
     salir
   ========================================================================== */

'use strict';

const net = require('net');
const readline = require('readline');
const token = require('./token');

/* Socios de prueba para el mock. NO se publican UIDs ni semillas reales ni de
   demo en el repositorio: se leen de un fichero local (no versionado)
   acceso/mock-socios.json con la forma { "nombre": { "uid": "...", "seed": "..." } },
   o de la variable MSD_MOCK_SOCIOS (mismo JSON). Sin fichero, el mock arranca
   con un socio inventado al azar (válido solo para esta ejecución). */
function cargarSociosMock() {
  const fs = require('fs');
  const path = require('path');
  const crudo = process.env.MSD_MOCK_SOCIOS
    || (fs.existsSync(path.join(__dirname, 'mock-socios.json'))
      ? fs.readFileSync(path.join(__dirname, 'mock-socios.json'), 'utf8') : '');
  if (crudo) { try { return JSON.parse(crudo); } catch (e) { console.error('[mock] mock-socios.json no es JSON válido'); } }
  const { randomInt, randomBytes } = require('crypto');
  const uid = String(randomInt(100000000, 999999999));
  const seed = randomBytes(8).toString('hex');
  console.log(`[mock] sin mock-socios.json: socio de prueba aleatorio uid=${uid} seed=${seed}`);
  return { prueba: { uid, seed } };
}
const SOCIOS = cargarSociosMock();

const PUERTOS = { entrada: 8899, salida: 9999 };
const clientes = { entrada: new Set(), salida: new Set() };

function servidor(direccion, puerto) {
  const srv = net.createServer((sock) => {
    clientes[direccion].add(sock);
    console.log(`[mock] servicio conectado al lector de ${direccion}`);
    sock.on('close', () => clientes[direccion].delete(sock));
    sock.on('error', () => clientes[direccion].delete(sock));
  });
  srv.listen(puerto, () => console.log(`[mock] lector de ${direccion} escuchando en TCP ${puerto}`));
  return srv;
}

function emitir(direccion, texto) {
  const linea = texto + '\r\n';
  for (const s of clientes[direccion]) { try { s.write(linea); } catch (e) { /* cerrado */ } }
  console.log(`[mock] → ${direccion}: ${texto}`);
}

/* NFC real: el lector manda el UID dos veces seguidas. */
function pasarNfc(direccion, uid) {
  emitir(direccion, uid);
  setTimeout(() => emitir(direccion, uid), 250);
}

function pasarQr(direccion, socio) {
  const s = SOCIOS[socio];
  if (!s) { console.log('[mock] socio desconocido:', socio); return; }
  emitir(direccion, token.generar(s.uid, s.seed).payload);
}

servidor('entrada', PUERTOS.entrada);
servidor('salida', PUERTOS.salida);

/* ---------- Modo automático: secuencia de prueba ---------- */

if (process.argv[2] === 'auto') {
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    // Espera a que el servicio se conecte a ambos lectores.
    while (clientes.entrada.size === 0 || clientes.salida.size === 0) await espera(200);
    await espera(400);
    console.log('\n[mock] === secuencia de prueba ===');
    pasarNfc('entrada', SOCIOS.carmen.uid); await espera(1200);   // OK (y prueba dedup: 2 lecturas → 1)
    pasarQr('entrada', 'paco');             await espera(1200);   // OK por QR dinámico
    pasarNfc('entrada', '9000000001');      await espera(1200);   // DENEGADO: no reconocido
    pasarNfc('entrada', SOCIOS.lucia.uid);  await espera(1200);   // DENEGADO: abono caducado
    pasarNfc('salida',  SOCIOS.carmen.uid); await espera(1200);   // OK: salida registrada
    console.log('[mock] === fin de la secuencia ===\n');
    await espera(600);
    process.exit(0);
  })();
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'mock> ' });
  rl.prompt();
  rl.on('line', (l) => {
    const [cmd, arg] = l.trim().split(/\s+/);
    if (cmd === 'e') pasarNfc('entrada', arg);
    else if (cmd === 's') pasarNfc('salida', arg);
    else if (cmd === 'qe') pasarQr('entrada', arg);
    else if (cmd === 'qs') pasarQr('salida', arg);
    else if (cmd === 'salir' || cmd === 'exit') process.exit(0);
    else if (cmd) console.log('Comandos: e <uid> | s <uid> | qe <socio> | qs <socio> | salir');
    rl.prompt();
  });
}
