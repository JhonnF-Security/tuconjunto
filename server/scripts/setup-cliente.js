'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');

/**
 * Configuración por defecto del nuevo cliente
 * @param {object} opts - Opciones del cliente
 * @param {string} opts.nombre - Nombre del conjunto (ej. "Altos del Bosque")
 * @param {string} opts.plan - Plan contratado (basico, profesional, empresarial)
 * @param {string} [opts.frecuenciaBackup] - 'diario', 'semanal', 'quincenal'
 * @param {number} [opts.retencionDias] - Días de retención de backup (30, 60, 90)
 */
function configurarCliente({ nombre, plan, frecuenciaBackup = 'semanal', retencionDias = 30 }) {
  console.log(`=== CONFIGURANDO CLIENTE: ${nombre} ===`);
  console.log(`Plan: ${plan}`);
  console.log(`Frecuencia de backup: ${frecuenciaBackup}`);
  console.log(`Retención de backup: ${retencionDias} días\n`);

  // 1. Crear carpeta de datos del cliente
  const clienteDir = path.join(RAIZ, 'data', nombre.toLowerCase().replace(/[^a-z0-9]/g, '-'));
  fs.mkdirSync(clienteDir, { recursive: true });
  console.log(`📁 Carpeta de datos: ${clienteDir}`);

  // 2. Ruta de la BD del cliente
  const dbPath = path.join(clienteDir, 'tuconjunto.db');
  const dbDir = path.dirname(dbPath);

  // Limpiar TODOS los archivos relacionados con la BD anterior en ese directorio
  try {
    // Eliminar archivo principal y WAL/SHM
    fs.rmSync(dbPath, { recursive: true, force: true });
    fs.rmSync(dbPath + '-wal', { force: true });
    fs.rmSync(dbPath + '-shm', { force: true });
    // Eliminar toda la carpeta del cliente por si había restos
    fs.rmSync(clienteDir, { recursive: true, force: true });
    // y recrearla
    fs.mkdirSync(clienteDir, { recursive: true });
    console.log('♻️  Directorios de BD limpiados y recreados');
  } catch (e) {
    console.warn('⚠️  No se pudieron limpiar restos anteriores, intentando de nuevo...');
    fs.mkdirSync(clienteDir, { recursive: true });
  }

  // 3. Ejecutar seed con la nueva ruta de BD
  console.log('🌱 Ejecutando seed...');
  try {
    execSync(
      `RUTA_DB=${dbPath} node ${path.join(RAIZ, 'src', 'seed.js')}`,
      { stdio: 'inherit' }
    );
    console.log('✅ Seed completado\n');
  } catch (e) {
    console.error('❌ Error ejecutando seed:', e.message);
    process.exit(1);
  }

  // 4. Crear archivo .env del cliente
  const envContent = `
# TuConjunto — Configuración para ${nombre}
# Generado automáticamente por setup-cliente.js

# --- Identidad ---
NOMBRE_CONJUNTO="${nombre}"
PLAN_CONTRATO="${plan}"

# --- Base de datos ---
DB_FILE="data/${nombre.toLowerCase().replace(/[^a-z0-9]/g, '-')}/tuconjunto.db"
RUTA_DB="${dbPath}"

# --- Seguridad ---
COOKIE_SECURE="auto"
TRUST_PROXY=0

# --- Frecuencia y retención de backup ---
FRECUENCIA_BACKUP="${frecuenciaBackup}"
BACKUP_RETENTION_DAYS="${retencionDias}"

# --- Pasarela de pagos (desactivado por defecto, activar con Wompi) ---
PAYMENTS_PROVIDER="none"
WOMPI_ENV="sandbox"
WOMPI_PUBLIC_KEY=""
WOMPI_PRIVATE_KEY=""
WOMPI_INTEGRITY_SECRET=""
WOMPI_EVENTS_SECRET=""

# --- URLs ---
APP_PUBLIC_BASE_URL="http://localhost:8081"
`.trim();

  const envPath = path.join(RAIZ, '.env');
  fs.writeFileSync(envPath, envContent + '\n');
  console.log(`📄 Archivo .env actualizado: ${envPath}\n`);

  // 5. Configurar cron job de backup según frecuencia
  configurarCronBackup(frecuenciaBackup, retencionDias, dbPath);

  // 6. Resumen final
  console.log('=== RESUMEN ===');
  console.log(`Nombre del conjunto: ${nombre}`);
  console.log(`Plan: ${plan}`);
  console.log(`Ruta BD: ${dbPath}`);
  console.log(`Frecuencia backup: ${frecuenciaBackup} (retención ${retencionDias} días)`);
  console.log('=================\n');

  console.log('Próximos pasos:');
  console.log('  1. Revisar y ajustar .env si es necesario');
  console.log('  2. Ejecutar: npm run create-admin -- --documento DOC --nombre "Nombre"');
  console.log('  3. Ejecutar: npm start (o start:https con TLS)');
  console.log('  4. Probar login y explorar el panel');
  console.log('  5. Verificar que el backup se genere en la primera ejecución\n');
}

/**
 * Configura el cron job de backup según la frecuencia elegida
 */
function configurarCronBackup(frecuencia, retencionDias, dbPath) {
  const cronDir = path.join(RAIZ, 'config', 'cron');
  fs.mkdirSync(cronDir, { recursive: true });

  let cronLine;
  let comentario;

  switch (frecuencia) {
    case 'diario':
      cronLine = '0 3 * * *';
      comentario = 'Backup diario a las 03:00';
      break;
    case 'semanal':
      cronLine = '0 3 * * 0';
      comentario = 'Backup semanal los domingos a las 03:00';
      break;
    case 'quincenal':
      cronLine = '0 1 1,15 * *';
      comentario = 'Backup quincenal (1 y 15) a las 01:00';
      break;
    default:
      cronLine = `0 3 * * 0`;
      comentario = 'Backup semanal por defecto';
  }

  const cronFile = path.join(cronDir, 'backup-cliente.cron');
  const cronContent = `# ${comentario}\n# Cliente: se ejecuta desde server/\n${cronLine} cd ${RAIZ}/server && DB_FILE="${dbPath}" ./scripts/backup.sh >> backups/${path.basename(dbPath)}-log 2>&1\n`;

  fs.writeFileSync(cronFile, cronContent);
  console.log(`⏰ Cron job configurado: ${cronContent.trim()}`);
}

/**
 * Ejecutar si este script es llamado directamente
 */
if (require.main === module) {
  const args = process.argv.slice(2);
  const opciones = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const clave = args[i].replace('--', '');
      opciones[clave] = args[i + 1] || true;
      i++;
    }
  }

  if (!opciones.nombre) {
    console.error('❌ Falta el parámetro --nombre "Nombre del Conjunto"');
    console.error('Uso: node setup-cliente.js --nombre "Altos del Bosque" --plan profesional --frecuencia diario --retencion 60');
    process.exit(1);
  }

  configurarCliente({
    nombre: opciones.nombre,
    plan: opciones.plan || 'basico',
    frecuenciaBackup: opciones.frecuencia || 'semanal',
    retencionDias: Number(opciones.retencion) || 30,
  });
}

module.exports = { configurarCliente };