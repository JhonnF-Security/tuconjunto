'use strict';

const fs = require('fs');
const path = require('path');

// Base limpia: elimina el archivo (y sus WAL/SHM) ANTES de abrir la conexión.
// Si se provee RUTA_DB por línea de comando, se usa esa; si no, la por defecto.
const DB_PATH = process.env.RUTA_DB || path.join(__dirname, '..', 'data', 'tuconjunto.db');

// Guard: si otro proceso (p.ej. el servidor) tiene la BD abierta, el seed
// borraría y recrearía el archivo pero aquel seguiría usando el viejo
// (desvinculado) → datos "fantasma" y logins que no cuadran. Detener primero.
function procesosConLaBdAbierta(ruta) {
  const encontrados = [];
  try {
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
      try {
        for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
          let destino = '';
          try { destino = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
          if (destino === ruta || destino.startsWith(`${ruta}-wal`) || destino.startsWith(`${ruta}-shm`)) {
            encontrados.push(pid);
            break;
          }
        }
      } catch { /* proceso desaparecido o sin permisos */ }
    }
  } catch { /* sin /proc (no Linux): no se puede detectar */ }
  return encontrados;
}

const ocupadaPor = procesosConLaBdAbierta(DB_PATH);
if (ocupadaPor.length && !process.argv.includes('--forzar')) {
  console.error('✋ DETÉN el servidor antes de hacer seed.');
  console.error(`   Procesos con la BD abierta: ${[...new Set(ocupadaPor)].join(', ')}`);
  console.error('   El seed borra y recrea el archivo: un servidor vivo seguiría');
  console.error('   leyendo el archivo viejo. Orden correcto:');
  console.error('     1) detén el servidor   2) npm run seed   3) npm start');
  console.error('   (usa --forzar para ignorar esta comprobación)');
  process.exit(1);
}

for (const sufijo of ['', '-wal', '-shm']) {
  try {
    fs.rmSync(DB_PATH + sufijo, { force: true });
  } catch {
    /* noop */
  }
}

const { db, crearEsquema } = require('./db');

/* ------------------------------------------------------------------ */
/* 1. Crear esquema vacío (solo tablas, sin datos de demo)            */
/* ------------------------------------------------------------------ */
crearEsquema(db);

/* ------------------------------------------------------------------ */
/* 2. Insertar config por defecto (solo estructura, sin nombre específico) */
/* ------------------------------------------------------------------ */
db.prepare("INSERT INTO config(clave,valor) VALUES('nombre_conjunto','Nuevo Conjunto')").run();

// Parámetros de seguridad por defecto (plantilla inicial).
db.prepare("INSERT INTO config(clave,valor) VALUES('seguridad',?)").run(
  JSON.stringify({
    sesion_minutos: 60,
    recordarme_horas: 12,
    intentos_login: 5,
    bloqueo_minutos: 15,
    password_min: 8,
  })
);

/* ------------------------------------------------------------------ */
/* 3. Confirmación y salida                                           */
/* ------------------------------------------------------------------ */
console.log('✅ Seed limpio completado — esquema de BD creado vacío');
console.log(`Base de datos: ${DB_PATH}`);
console.log('No se insertaron datos de demo. Use scripts de setup por cliente.');
console.log('Ejemplo: node src/seed.js (crea DB vacía con esquema)');

db.close();
