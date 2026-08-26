'use strict';

const fs = require('fs');
const path = require('path');

// Base limpia: elimina el archivo (y sus WAL/SHM) ANTES de abrir la conexión.
const DB_PATH = path.join(__dirname, '..', 'data', 'tuconjunto.db');

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
const { hashPassword } = require('./util');

crearEsquema(db);

const CLAVE_DEMO = 'demo1234';
const AHORA = Date.now();
const ANIO = new Date().getFullYear();
const hashDemo = hashPassword(CLAVE_DEMO);

/* ------------------------------- Unidades ------------------------------ */
const TORRES = ['T1', 'T2', 'T3', 'T4'];
const APTOS = ['101', '102', '103', '201', '202', '203', '204', '301', '302', '401', '402', '501', '502'];

const unidades = [];
for (const torre of TORRES) {
  for (const apto of APTOS) {
    unidades.push({ torre, apto });
  }
}
// Coeficientes deterministas normalizados a ~100 %.
const bruto = unidades.map((_, i) => 2 + ((i * 7) % 11) / 10); // 2.0 – 3.0
const sumaBruta = bruto.reduce((a, b) => a + b, 0);
const coeficientes = bruto.map((b) => Math.round((b / sumaBruta) * 10000) / 100); // %

const insertarUnidad = db.prepare(
  'INSERT INTO unidades(torre,apto,coeficiente,propietario_id) VALUES(?,?,?,?)'
);
unidades.forEach((u, i) => insertarUnidad.run(u.torre, u.apto, coeficientes[i], null));

const idUnidad = (torre, apto) =>
  db.prepare('SELECT id FROM unidades WHERE torre = ? AND apto = ?').get(torre, apto).id;

// Unidades extra del seed v2 (si no existen ya en el grid).
const asegurarUnidad = db.prepare(
  'INSERT INTO unidades(torre,apto,coeficiente) SELECT ?, ?, NULL WHERE NOT EXISTS(SELECT 1 FROM unidades WHERE torre = ? AND apto = ?)'
);
asegurarUnidad.run('T2', '504', 'T2', '504'); // Camila Torres
asegurarUnidad.run('T1', '102', 'T1', '102'); // Andrés Mora (ya existe en el grid)

/* ------------------------------- Usuarios ------------------------------ */
const insertarUsuario = db.prepare(
  `INSERT INTO usuarios(nombre,tipo_doc,documento,email,celular,rol,estado,unidad_id,password_hash,debe_cambiar_clave,failed_attempts,locked_until,creado_en)
   VALUES(?,?,?,?,?,?,?,?,?,0,0,NULL,?)`
);

const personas = [
  { nombre: 'Jorge Ramírez', doc: '1020001', rol: 'administrador', unidad: null, email: 'jorge.ramirez@altosdelbosque.co' },
  { nombre: 'Marta Ruiz', doc: '1020002', rol: 'consejo', unidad: ['T3', '204'], email: 'marta.ruiz@altosdelbosque.co' },
  { nombre: 'Carlos Vega', doc: '1020003', rol: 'porteria', unidad: null, email: null },
  { nombre: 'Ana María Gómez', doc: '1020004', rol: 'copropietario', unidad: ['T2', '502'], email: 'ana.gomez@example.com' },
  { nombre: 'Pedro Salas', doc: '1020005', rol: 'arrendatario', unidad: ['T2', '103'], email: 'pedro.salas@example.com' },
  { nombre: 'Carlos Peña', doc: '1020006', rol: 'copropietario', unidad: ['T1', '301'], email: 'carlos.pena@example.com' },
  { nombre: 'Luis Ospina', doc: '1020007', rol: 'copropietario', unidad: ['T4', '401'], estado: 'Suspendido', email: 'luis.ospina@example.com' },
  // Pendientes de aprobación (demo flujo autorregistro → aprobación admin).
  { nombre: 'Camila Torres', doc: '1020008', rol: 'copropietario', unidad: ['T2', '504'], estado: 'Pendiente aprobación', email: 'camila.torres@example.com' },
  { nombre: 'Andrés Mora', doc: '1020009', rol: 'arrendatario', unidad: ['T1', '102'], estado: 'Pendiente aprobación', email: 'andres.mora@example.com' },
];

const idsUsuarios = {};
for (const p of personas) {
  const unidadId = p.unidad ? idUnidad(p.unidad[0], p.unidad[1]) : null;
  const info = insertarUsuario.run(
    p.nombre,
    'CC',
    p.doc,
    p.email,
    p.celular || `310${p.doc.slice(-7)}`,
    p.rol,
    p.estado || 'Activo',
    unidadId,
    hashDemo,
    AHORA
  );
  idsUsuarios[p.nombre] = Number(info.lastInsertRowid);
  if (
    unidadId &&
    (p.rol === 'copropietario' || p.rol === 'consejo') &&
    p.estado !== 'Pendiente aprobación'
  ) {
    db.prepare('UPDATE unidades SET propietario_id = ? WHERE id = ?').run(idsUsuarios[p.nombre], unidadId);
  }
}

/* -------------------------------- Zonas -------------------------------- */
const insertarZona = db.prepare('INSERT INTO zonas(nombre,capacidad,costo_hora,activa) VALUES(?,?,?,1)');
insertarZona.run('Salón Social', 40, 50000);
insertarZona.run('Zona BBQ', 15, 30000);
insertarZona.run('Piscina', 20, 0);
insertarZona.run('Gimnasio', 10, 0);
insertarZona.run('Cancha sintética', 12, 20000);

const idZona = (nombre) => db.prepare('SELECT id FROM zonas WHERE nombre = ?').get(nombre).id;

/* -------------------------------- Pagos -------------------------------- */
// Julio Pagado (PG-88212, todas las unidades) · Agosto Pendiente.
const insertarPago = db.prepare(
  'INSERT INTO pagos(unidad_id,concepto,periodo,valor,estado,metodo,referencia,fecha_pago,registrado_por) VALUES(?,?,?,?,?,?,?,?,NULL)'
);
const VALOR_ADMIN = 250000;
const fechaJulio = new Date(ANIO, 6, 28, 10, 0, 0).getTime();

const todasUnidades = db.prepare('SELECT id FROM unidades ORDER BY id').all();
for (const u of todasUnidades) {
  insertarPago.run(u.id, 'Administración', `${ANIO}-07`, VALOR_ADMIN, 'Pagado', 'PSE', 'PG-88212', fechaJulio);
  insertarPago.run(u.id, 'Administración', `${ANIO}-08`, VALOR_ADMIN, 'Pendiente', 'PSE', null, null);
}

/* ------------------------------- Reservas ------------------------------ */
const insertarReserva = db.prepare(
  'INSERT INTO reservas(zona_id,usuario_id,fecha,franja,notas,estado,revisada_por,creado_en) VALUES(?,?,?,?,?,?,?,?)'
);
insertarReserva.run(
  idZona('Salón Social'),
  idsUsuarios['Ana María Gómez'],
  `${ANIO}-08-29`,
  'tarde',
  'Cumpleaños familiar',
  'Confirmada',
  idsUsuarios['Jorge Ramírez'],
  AHORA - 3 * 24 * 3600 * 1000
);
insertarReserva.run(
  idZona('Zona BBQ'),
  idsUsuarios['Pedro Salas'],
  `${ANIO}-08-30`,
  'noche',
  null,
  'Pendiente',
  null,
  AHORA - 24 * 3600 * 1000
);

/* --------------------------------- PQRS -------------------------------- */
const insertarPqrs = db.prepare(
  'INSERT INTO pqrs(codigo,usuario_id,titulo,descripcion,tipo,prioridad,estado,asignado_a,creada_en,resuelta_en) VALUES(?,?,?,?,?,?,?,?,?,?)'
);
insertarPqrs.run(
  'T-0398',
  idsUsuarios['Ana María Gómez'],
  'Ruido excesivo en la Torre 2',
  'Los vecinos del apartamento 502 realizan fiestas hasta altas horas de la noche.',
  'Convivencia',
  'Media',
  'En revisión',
  idsUsuarios['Jorge Ramírez'],
  AHORA - 2 * 24 * 3600 * 1000,
  null
);
insertarPqrs.run(
  'T-0351',
  idsUsuarios['Pedro Salas'],
  'Fuga de agua en parqueadero',
  'Se presenta una fuga constante en el sótano 1 cerca al ascensor.',
  'Mantenimiento',
  'Alta',
  'Resuelto',
  idsUsuarios['Jorge Ramírez'],
  AHORA - 8 * 24 * 3600 * 1000,
  AHORA - 5 * 24 * 3600 * 1000
);

/* ----------------------------- Comunicados ----------------------------- */
const insertarComunicado = db.prepare(
  'INSERT INTO comunicados(titulo,cuerpo,categoria,autor_id,creado_en) VALUES(?,?,?,?,?)'
);
insertarComunicado.run(
  'Asamblea general extraordinaria',
  `Se convoca a todos los copropietarios a la asamblea extraordinaria sobre el mantenimiento de fachadas el ${ANIO}-09-12 en el Salón Social.`,
  'Asamblea',
  idsUsuarios['Jorge Ramírez'],
  AHORA - 4 * 24 * 3600 * 1000
);
insertarComunicado.run(
  'Corte programado de agua',
  'El próximo sábado de 8:00 a.m. a 12:00 m. habrá corte del servicio de agua por mantenimiento de tanques.',
  'Servicio',
  idsUsuarios['Jorge Ramírez'],
  AHORA - 2 * 24 * 3600 * 1000
);
insertarComunicado.run(
  'Recordatorio de convivencia',
  'Recuerda no ocupar zonas comunes después de las 10:00 p.m. y respetar los horarios de la sala de gym.',
  'Convivencia',
  idsUsuarios['Marta Ruiz'],
  AHORA - 24 * 3600 * 1000
);

/* ------------------------------- Asamblea ------------------------------ */
db.prepare(
  "INSERT INTO asambleas(titulo,fecha,lugar,opciones,estado,creada_por,creado_en) VALUES(?,?,?,?,'Convocada',?,?)"
).run(
  'Extraordinaria fachada',
  `${ANIO}-09-12`,
  'Salón Social',
  JSON.stringify(['Sí', 'No']),
  idsUsuarios['Jorge Ramírez'],
  AHORA - 4 * 24 * 3600 * 1000
);

/* -------------------------------- Visitas ------------------------------ */
const insertarVisita = db.prepare(
  'INSERT INTO visitas(nombre,documento,tipo,unidad_destino,motivo,foto_rostro,foto_cedula,entrada,salida,registrada_por) VALUES(?,?,?,?,?,?,?, ?, ?, ?)'
);
const MIN = 60 * 1000;
insertarVisita.run('María Fernanda Torres', 'CC 1032456789', 'Visitante', 'T2-502', 'Visita a residente', null, null, AHORA - 120 * MIN, null, idsUsuarios['Carlos Vega']);
insertarVisita.run('Andrés Camilo Rojas', 'CC 79874512', 'Domiciliario', 'T1-301', 'Entrega de domicilio', null, null, AHORA - 25 * MIN, null, idsUsuarios['Carlos Vega']);
insertarVisita.run('Laura Gómez Ruiz', 'CC 52987413', 'Proveedor', 'Zonas comunes', 'Mantenimiento de piscina', null, null, AHORA - 180 * MIN, AHORA - 90 * MIN, idsUsuarios['Carlos Vega']);
insertarVisita.run('Jorge Iván Peña', 'CC 19123456', 'Domiciliario', 'T3-204', 'Entrega de correspondencia', null, null, AHORA - 320 * MIN, AHORA - 300 * MIN, idsUsuarios['Carlos Vega']);

/* -------------------------------- Config ------------------------------- */
db.prepare("INSERT INTO config(clave,valor) VALUES('nombre_conjunto','Conjunto Residencial Altos del Bosque')").run();

// Parámetros de seguridad por defecto (contrato v2).
db.prepare("INSERT INTO config(clave,valor) VALUES('seguridad',?)").run(
  JSON.stringify({
    sesion_minutos: 60,
    recordarme_horas: 12,
    intentos_login: 5,
    bloqueo_minutos: 15,
    password_min: 8,
  })
);

/* -------------------------------- Resumen ------------------------------ */
console.log('Seed completado ✔');
console.log(`Base de datos: ${DB_PATH}`);
console.log(`Contraseña demo para TODOS los usuarios: ${CLAVE_DEMO}`);
console.log('');
console.log('  Rol            Documento  Nombre              Unidad');
console.log('  administrador  1020001    Jorge Ramírez       —');
console.log('  consejo        1020002    Marta Ruiz          T3-204');
console.log('  porteria       1020003    Carlos Vega         —');
console.log('  copropietario  1020004    Ana María Gómez     T2-502');
console.log('  arrendatario   1020005    Pedro Salas         T2-103');
console.log('  copropietario  1020006    Carlos Peña (mora)  T1-301');
console.log('  copropietario  1020007    Luis Ospina (susp.) T4-401');
console.log('  copropietario  1020008    Camila Torres (pend.) T2-504');
console.log('  arrendatario   1020009    Andrés Mora (pend.) T1-102');
console.log('');
console.log(
  `Resumen: ${todasUnidades.length} unidades · 5 zonas · ${todasUnidades.length * 2} pagos · 2 reservas · 2 PQRS · 3 comunicados · 1 asamblea · 4 visitas`
);

db.close();
