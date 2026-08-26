'use strict';

const express = require('express');
const { db } = require('../db');
const { validar, ahoraMs } = require('../util');
const { ok, wrap, httpError, requireAuth, requireRole } = require('../middleware');

const router = express.Router();

const ROLES_RESIDENTE = ['copropietario', 'arrendatario'];

function conOpciones(fila) {
  let opciones = [];
  try {
    const parsed = JSON.parse(fila.opciones);
    if (Array.isArray(parsed)) opciones = parsed.map(String);
  } catch {
    opciones = [];
  }
  return { ...fila, opciones };
}

const LISTA = `
  SELECT a.id, a.titulo, a.fecha, a.lugar, a.opciones, a.estado,
         u.nombre AS creada_nombre, a.creada_por, a.creado_en,
         (SELECT COUNT(*) FROM asamblea_asistencia x WHERE x.asamblea_id = a.id) AS total_asistencia,
         (SELECT COUNT(*) FROM asamblea_votos v WHERE v.asamblea_id = a.id) AS total_votos
  FROM asambleas a LEFT JOIN usuarios u ON u.id = a.creada_por`;

// Conteos por opción + asistencia; mi_voto / mi_asistencia para residentes.
router.get('/', requireAuth, (req, res) => {
  const filas = db.prepare(`${LISTA} ORDER BY a.fecha DESC`).all();
  const esResidente = ROLES_RESIDENTE.includes(req.usuario.rol);
  const conteoVotos = db.prepare(
    'SELECT opcion, COUNT(*) AS count FROM asamblea_votos WHERE asamblea_id = ? GROUP BY opcion'
  );
  const miVoto = db.prepare('SELECT opcion FROM asamblea_votos WHERE asamblea_id = ? AND usuario_id = ?');
  const miAsistencia = db.prepare(
    'SELECT 1 AS x FROM asamblea_asistencia WHERE asamblea_id = ? AND usuario_id = ?'
  );

  const asambleas = filas.map((f) => {
    const base = conOpciones(f);
    const mapa = Object.fromEntries(conteoVotos.all(f.id).map((r) => [r.opcion, r.count]));
    const votos = base.opciones.map((op) => ({ opcion: op, count: mapa[op] || 0 }));
    for (const [opcion, count] of Object.entries(mapa)) {
      if (!base.opciones.includes(opcion)) votos.push({ opcion, count });
    }
    const salida = { ...base, votos, asistentes: Number(f.total_asistencia) || 0 };
    if (esResidente) {
      const voto = miVoto.get(f.id, req.usuario.id);
      salida.mi_voto = voto ? voto.opcion : null;
      salida.mi_asistencia = !!miAsistencia.get(f.id, req.usuario.id);
    }
    return salida;
  });

  ok(res, { asambleas });
});

router.post('/', requireAuth, requireRole('administrador'), wrap(async (req, res) => {
  const v = validar(
    {
      titulo: { tipo: 'string', requerido: true, max: 150 },
      fecha: { tipo: 'fecha', requerido: true },
      lugar: { tipo: 'string', requerido: true, max: 120 },
      opciones: { tipo: 'lista', requerido: true, minItems: 2, maxItems: 10, itemMax: 60 },
    },
    req.body
  );
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);
  const d = v.valores;

  const info = db
    .prepare("INSERT INTO asambleas(titulo,fecha,lugar,opciones,estado,creada_por,creado_en) VALUES(?,?,?,?, 'Convocada',?,?)")
    .run(d.titulo, d.fecha, d.lugar, JSON.stringify(d.opciones), req.usuario.id, ahoraMs());

  const fila = db.prepare(`${LISTA} WHERE a.id = ?`).get(info.lastInsertRowid);
  ok(res, { asamblea: conOpciones(fila) }, 201);
}));

router.post('/:id/asistencia', requireAuth, requireRole(...ROLES_RESIDENTE), wrap(async (req, res) => {
  const asamblea = db.prepare('SELECT * FROM asambleas WHERE id = ?').get(Number(req.params.id));
  if (!asamblea) throw httpError(404, 'NO_ENCONTRADO', 'Asamblea no encontrada');

  const existente = db
    .prepare('SELECT 1 FROM asamblea_asistencia WHERE asamblea_id = ? AND usuario_id = ?')
    .get(asamblea.id, req.usuario.id);

  if (existente) {
    db.prepare('DELETE FROM asamblea_asistencia WHERE asamblea_id = ? AND usuario_id = ?').run(asamblea.id, req.usuario.id);
    return ok(res, { asistiendo: false });
  }
  db.prepare('INSERT INTO asamblea_asistencia(asamblea_id,usuario_id,creado_en) VALUES(?,?,?)').run(
    asamblea.id,
    req.usuario.id,
    ahoraMs()
  );
  ok(res, { asistiendo: true });
}));

router.post('/:id/voto', requireAuth, requireRole(...ROLES_RESIDENTE), wrap(async (req, res) => {
  const v = validar({ opcion: { tipo: 'string', requerido: true, max: 60 } }, req.body);
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);

  const asamblea = db.prepare('SELECT * FROM asambleas WHERE id = ?').get(Number(req.params.id));
  if (!asamblea) throw httpError(404, 'NO_ENCONTRADO', 'Asamblea no encontrada');
  if (asamblea.estado === 'Cerrada') throw httpError(409, 'CERRADA', 'La votación está cerrada');

  const opciones = conOpciones(asamblea).opciones;
  if (!opciones.includes(v.valores.opcion)) {
    throw httpError(400, 'OPCION_INVALIDA', `La opción debe ser una de: ${opciones.join(', ')}`);
  }

  try {
    db.prepare('INSERT INTO asamblea_votos(asamblea_id,usuario_id,opcion,creado_en) VALUES(?,?,?,?)').run(
      asamblea.id,
      req.usuario.id,
      v.valores.opcion,
      ahoraMs()
    );
  } catch (e) {
    if (e && typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) {
      throw httpError(409, 'YA_VOTO', 'Cada persona solo puede emitir un voto');
    }
    throw e;
  }
  ok(res, { voto: v.valores.opcion }, 201);
}));

router.patch('/:id', requireAuth, requireRole('administrador'), wrap(async (req, res) => {
  const v = validar({ estado: { tipo: 'enum', enum: ['Cerrada'], requerido: true } }, req.body);
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);

  const asamblea = db.prepare('SELECT * FROM asambleas WHERE id = ?').get(Number(req.params.id));
  if (!asamblea) throw httpError(404, 'NO_ENCONTRADO', 'Asamblea no encontrada');

  db.prepare('UPDATE asambleas SET estado = ? WHERE id = ?').run(v.valores.estado, asamblea.id);
  const fila = db.prepare(`${LISTA} WHERE a.id = ?`).get(asamblea.id);
  ok(res, { asamblea: conOpciones(fila) });
}));

module.exports = router;
