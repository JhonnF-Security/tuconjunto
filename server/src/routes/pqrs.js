'use strict';

const express = require('express');
const { db } = require('../db');
const { validar, ahoraMs } = require('../util');
const { ok, wrap, httpError, auditar, requireAuth, requireRole } = require('../middleware');

const router = express.Router();

const TIPOS = ['Convivencia', 'Mantenimiento', 'Administrativo', 'Otro'];
const PRIORIDADES = ['Baja', 'Media', 'Alta'];
const ROLES_RESIDENTE = ['copropietario', 'arrendatario'];

function siguienteCodigo() {
  const fila = db
    .prepare("SELECT MAX(CAST(SUBSTR(codigo, 3) AS INTEGER)) AS maximo FROM pqrs WHERE codigo LIKE 'T-%'")
    .get();
  const siguiente = (fila && fila.maximo ? fila.maximo : 0) + 1;
  return `T-${String(siguiente).padStart(4, '0')}`;
}

const LISTA = `
  SELECT p.id, p.codigo, p.usuario_id, u.nombre AS usuario_nombre,
         p.titulo, p.descripcion, p.tipo, p.prioridad, p.estado,
         p.asignado_a, a.nombre AS asignado_nombre, p.creada_en, p.resuelta_en
  FROM pqrs p
  JOIN usuarios u ON u.id = p.usuario_id
  LEFT JOIN usuarios a ON a.id = p.asignado_a`;

router.get('/', requireAuth, wrap(async (req, res) => {
  const esStaff = req.usuario.rol === 'administrador' || req.usuario.rol === 'consejo';
  let filas;
  if (esStaff) {
    filas = db.prepare(`${LISTA} ORDER BY p.creada_en DESC`).all();
  } else {
    filas = db.prepare(`${LISTA} WHERE p.usuario_id = ? ORDER BY p.creada_en DESC`).all(req.usuario.id);
  }
  ok(res, { pqrs: filas });
}));

router.post('/', requireAuth, requireRole(...ROLES_RESIDENTE), wrap(async (req, res) => {
  const v = validar(
    {
      titulo: { tipo: 'string', requerido: true, max: 120 },
      descripcion: { tipo: 'string', requerido: true, max: 2000 },
      tipo: { tipo: 'enum', enum: TIPOS, requerido: true },
      prioridad: { tipo: 'enum', enum: PRIORIDADES, requerido: true },
    },
    req.body
  );
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);
  const d = v.valores;
  const codigo = siguienteCodigo();

  const info = db
    .prepare(
      "INSERT INTO pqrs(codigo,usuario_id,titulo,descripcion,tipo,prioridad,estado,asignado_a,creada_en,resuelta_en) VALUES(?,?,?,?,?,?,'Abierto',NULL,?,NULL)"
    )
    .run(codigo, req.usuario.id, d.titulo, d.descripcion, d.tipo, d.prioridad, ahoraMs());

  const fila = db.prepare(`${LISTA} WHERE p.id = ?`).get(info.lastInsertRowid);
  ok(res, { pqrs: fila }, 201);
}));

router.patch('/:id', requireAuth, requireRole('administrador'), wrap(async (req, res) => {
  const v = validar(
    { accion: { tipo: 'enum', enum: ['atender', 'resolver'], requerido: true } },
    req.body
  );
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);

  const pqrs = db.prepare('SELECT * FROM pqrs WHERE id = ?').get(Number(req.params.id));
  if (!pqrs) throw httpError(404, 'NO_ENCONTRADO', 'PQRS no encontrada');

  if (v.valores.accion === 'atender') {
    db.prepare("UPDATE pqrs SET estado = 'En revisión', asignado_a = ? WHERE id = ?").run(req.usuario.id, pqrs.id);
    auditar(req.usuario.id, 'pqrs_atendida', `codigo=${pqrs.codigo}`, req.socket.remoteAddress);
  } else {
    db.prepare("UPDATE pqrs SET estado = 'Resuelto', asignado_a = COALESCE(asignado_a, ?), resuelta_en = ? WHERE id = ?").run(
      req.usuario.id,
      ahoraMs(),
      pqrs.id
    );
    auditar(req.usuario.id, 'pqrs_resuelta', `codigo=${pqrs.codigo}`, req.socket.remoteAddress);
  }

  const fila = db.prepare(`${LISTA} WHERE p.id = ?`).get(pqrs.id);
  ok(res, { pqrs: fila });
}));

module.exports = router;
