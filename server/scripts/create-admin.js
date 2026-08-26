'use strict';

// Crea el primer usuario ADMINISTRADOR en una instalación limpia (producción).
// Uso:
//   node scripts/create-admin.js --documento 1020001 --nombre "Jorge Ramírez" \
//        --email jorge@conjunto.co --celular 3100000000 [--tipo-doc CC]
//   node scripts/create-admin.js --documento 1020001 --clave 'MiClaveSegura1'
// Sin --clave se genera una temporal aleatoria y se imprime UNA sola vez.
// La cuenta nace con debe_cambiar_clave=1: deberá cambiarla en el primer ingreso.

const crypto = require('crypto');
const path = require('path');

const args = process.argv.slice(2);
function arg(nombre) {
  const i = args.indexOf(`--${nombre}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

const documento = arg('documento');
const nombre = arg('nombre');
const email = arg('email');
const celular = arg('celular');
const tipoDoc = arg('tipo-doc') || 'CC';
let clave = arg('clave');

if (!documento || !/^\d{5,15}$/.test(documento)) {
  console.error('Uso: node scripts/create-admin.js --documento <numero> [--nombre "..."] [--email ...] [--celular ...] [--tipo-doc CC|CE|TI|PA] [--clave ...]');
  process.exit(1);
}
if (clave && (typeof clave !== 'string' || clave.length < 8 || !/[A-Za-z]/.test(clave) || !/\d/.test(clave))) {
  console.error('La clave debe tener mínimo 8 caracteres con letras y números.');
  process.exit(1);
}

const { db, crearEsquema } = require('../src/db');
crearEsquema(db);
const { hashPassword, ahoraMs } = require('../src/util');

if (db.prepare('SELECT id FROM usuarios WHERE documento = ?').get(documento)) {
  console.error(`Ya existe un usuario con documento ${documento}.`);
  process.exit(1);
}

if (!clave) clave = crypto.randomBytes(6).toString('hex'); // 12 caracteres

const info = db
  .prepare(
    `INSERT INTO usuarios(nombre,tipo_doc,documento,email,celular,rol,unidad_id,password_hash,debe_cambiar_clave,creado_en)
     VALUES(?,?,?,?,?,'administrador',NULL,?,1,?)`
  )
  .run(
    nombre || `Administrador ${documento}`,
    tipoDoc,
    documento,
    email || null,
    celular || null,
    hashPassword(clave),
    ahoraMs()
  );

console.log('Administrador creado correctamente.');
console.log(`  id        : ${info.lastInsertRowid}`);
console.log(`  documento : ${documento}`);
console.log(`  clave     : ${clave}   <- guárdala ahora; NO se volverá a mostrar`);
console.log('Deberá cambiarla en el primer ingreso (/login.html).');
