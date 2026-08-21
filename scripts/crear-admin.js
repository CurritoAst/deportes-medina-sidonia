#!/usr/bin/env node
/* ==========================================================================
   Crea (o promociona) un ADMINISTRADOR desde la consola del servidor.
   Uso:
     MSD_DB_HOST=localhost MSD_DB_NAME=deportes MSD_DB_USER=... MSD_DB_PASSWORD=... \
       node scripts/crear-admin.js --email admin@dominio.es --nombre "Nombre Apellidos"
   Pide la contraseña por teclado sin eco (mínimo 12 caracteres). Si el correo
   ya existe, lo promociona a admin y le cambia la contraseña.
   Alternativa sin SSH: variables MSD_BOOTSTRAP_ADMIN_* en el panel Node de Plesk
   (solo actúan si no existe ningún admin; borrarlas después).
   ========================================================================== */

'use strict';

const readline = require('readline');
const bd = require('../lib/bd');
const clave = require('../lib/clave');

function arg(n) { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : null; }

function pedirClave(pregunta) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const salidaOriginal = rl._writeToOutput;
    rl.question(pregunta, (v) => { rl._writeToOutput = salidaOriginal; process.stdout.write('\n'); rl.close(); resolve(v); });
    rl._writeToOutput = () => {};   // sin eco
  });
}

(async () => {
  if (!bd.configurada()) { console.error('Faltan las variables MSD_DB_* (host, name, user, password).'); process.exit(1); }
  const email = String(arg('email') || '').trim().toLowerCase();
  const nombre = String(arg('nombre') || 'Administración Deportes').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { console.error('Uso: node scripts/crear-admin.js --email correo@dominio.es --nombre "Nombre"'); process.exit(1); }
  const pass = await pedirClave(`Contraseña para ${email} (mín. 12, no se muestra): `);
  const pass2 = await pedirClave('Repite la contraseña: ');
  if (pass !== pass2) { console.error('No coinciden.'); process.exit(1); }
  const mal = clave.politicaClave(pass, { nombre, email });
  if (mal) { console.error(mal); process.exit(1); }
  if (pass.length < 12) { console.error('Para un administrador, mínimo 12 caracteres.'); process.exit(1); }
  const hash = await clave.hashear(pass);
  const ahora = new Date();
  const existe = await bd.uno('SELECT id, rol FROM usuarios WHERE email = ?', [email]);
  if (existe) {
    await bd.consulta("UPDATE usuarios SET rol = 'admin', clave_hash = ?, clave_cambiada_en = ?, email_verificado_en = COALESCE(email_verificado_en, ?), eliminado_en = NULL, fallos_login = 0, bloqueado_hasta = NULL, debe_cambiar_clave = 0 WHERE id = ?", [hash, ahora, ahora, existe.id]);
    await bd.consulta('DELETE FROM sesiones WHERE usuario_id = ?', [existe.id]);
    console.log(`Usuario existente promocionado a admin y contraseña cambiada: ${email}`);
  } else {
    await bd.consulta("INSERT INTO usuarios (email, nombre, rol, clave_hash, email_verificado_en, acepta_normas_en) VALUES (?, ?, 'admin', ?, ?, ?)", [email, nombre, hash, ahora, ahora]);
    console.log(`Administrador creado: ${email}`);
  }
  await bd.consulta("INSERT INTO registro_actividad (tipo, texto, entidad) VALUES ('sistema', ?, 'usuario')", [`Admin creado/promocionado desde consola: ${email}`]);
  await bd.cerrar();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
