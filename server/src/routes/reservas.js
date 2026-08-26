'use strict';

const express = require('express');
const { db } = require('../db');
const { validar, ahoraMs } = require('../util');
const { ok, wrap, httpError, auditar, requireAuth, requireRole } = require('../middleware');

const router = express.Router();

const FRANJAS = ['manana', 'tarde', 'noche'];
const ROLES_RESIDENTE = ['copropietario', 'arrendatario'];

const LISTA = `
  SELECT r.id, r.zona_id, z.nombre AS zona_nombre, r.usuario_id, u.nombre AS usuario_nombre,
         r.fecha, r.franja, r.notas, r.estado, r.revisada_por, r.creado_en
  FROM reservas r
  JOIN zonas z ON z.id = r.zona_id
  JOIN usuarios u ON u.id = r.usuario_id`;

function esAdminOConsejo(usuario) {
  return usuario.rol === 'administrador' || usuario.rol === 'consejo';
}

router.get('/', requireAuth, wrap(async (req, res) => {
  const mias = req.query.mias === '1' || req.query.mias === 'true';
  if (mias) {
    const filas = db.prepare(`${LISTA} WHERE r.usuario_id = ? ORDER BY r.fecha DESC, r.id DESC`).all(req.usuario.id);
    return ok(res, { reservas: filas });
  }
  if (!esAdminOConsejo(req.usuario)) {
    throw httpError(403, 'SIN_ROL', 'Solo administración o consejo pueden ver todas las reservas');
  }
  const filas = db.prepare(`${LISTA} ORDER BY r.fecha DESC, r.id DESC`).all();
  ok(res, { reservas: filas });
}));

router.post('/', requireAuth, requireRole(...ROLES_RESIDENTE), wrap(async (req, res) => {
  const v = validar(
    {
      zona_id: { tipo: 'int', requerido: true, min: 1 },
      fecha: { tipo: 'fecha', requerido: true },
      franja: { tipo: 'enum', enum: FRANJAS, requerido: true },
      notas: { tipo: 'string', requerido: false, max: 300 },
    },
    req.body
  );
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);
  const d = v.valores;

  const zona = db.prepare('SELECT * FROM zonas WHERE id = ?').get(d.zona_id);
  if (!zona) throw httpError(404, 'NO_ENCONTRADO', 'Zona no encontrada');
  if (!zona.activa) throw httpError(409, 'ZONA_INACTIVA', 'La zona no está disponible para reservas');

  const ocupada = db
    .prepare("SELECT id FROM reservas WHERE zona_id = ? AND fecha = ? AND franja = ? AND estado = 'Confirmada'")
    .get(d.zona_id, d.fecha, d.franja);
  if (ocupada) throw httpError(409, 'FRANJA_OCUPADA', 'Ya existe una reserva confirmada para esa zona, fecha y franja');

  try {
    const info = db
      .prepare(
        "INSERT INTO reservas(zona_id,usuario_id,fecha,franja,notas,estado,revisada_por,creado_en) VALUES(?,?,?,?,?,'Pendiente',NULL,?)"
      )
      .run(d.zona_id, req.usuario.id, d.fecha, d.franja, d.notas || null, ahoraMs());
    const fila = db.prepare(`${LISTA} WHERE r.id = ?`).get(info.lastInsertRowid);
    return ok(res, { reserva: fila }, 201);
  } catch (e) {
    if (e && typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) {
      // Índice parcial único (zona,fecha,franja) WHERE estado != 'Rechazada'.
      throw httpError(409, 'FRANJA_OCUPADA', 'Esa zona ya tiene una reserva activa para esa fecha y franja');
    }
    throw e;
  }
}));

router.patch('/:id', requireAuth, requireRole('administrador'), wrap(async (req, res) => {
  const v = validar(
    { accion: { tipo: 'enum', enum: ['aprobar', 'rechazar'], requerido: true } },
    req.body
  );
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);

  const reserva = db.prepare('SELECT * FROM reservas WHERE id = ?').get(Number(req.params.id));
  if (!reserva) throw httpError(404, 'NO_ENCONTRADO', 'Reserva no encontrada');
  if (reserva.estado === 'Cancelada') throw httpError(409, 'CANCELADA', 'La reserva fue cancelada por el residente');

  if (v.valores.accion === 'aprobar') {
    const ocupada = db
      .prepare(
        "SELECT id FROM reservas WHERE zona_id = ? AND fecha = ? AND franja = ? AND estado = 'Confirmada' AND id != ?"
      )
      .get(reserva.zona_id, reserva.fecha, reserva.franja, reserva.id);
    if (ocupada) throw httpError(409, 'FRANJA_OCUPADA', 'Ya existe otra reserva confirmada para ese horario');
    try {
      db.prepare("UPDATE reservas SET estado = 'Confirmada', revisada_por = ? WHERE id = ?").run(req.usuario.id, reserva.id);
    } catch (e) {
      if (e && typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) {
        throw httpError(409, 'FRANJA_OCUPADA', 'Conflicto de horario al confirmar la reserva');
      }
      throw e;
    }
    auditar(req.usuario.id, 'reserva_aprobada', `reserva=${reserva.id}`, req.socket.remoteAddress);
  } else {
    db.prepare("UPDATE reservas SET estado = 'Rechazada', revisada_por = ? WHERE id = ?").run(req.usuario.id, reserva.id);
    auditar(req.usuario.id, 'reserva_rechazada', `reserva=${reserva.id}`, req.socket.remoteAddress);
  }

  const fila = db.prepare(`${LISTA} WHERE r.id = ?`).get(reserva.id);
  ok(res, { reserva: fila });
}));

router.patch('/:id/cancelar', requireAuth, wrap(async (req, res) => {
  const reserva = db.prepare('SELECT * FROM reservas WHERE id = ?').get(Number(req.params.id));
  if (!reserva) throw httpError(404, 'NO_ENCONTRADO', 'Reserva no encontrada');
  if (reserva.usuario_id !== req.usuario.id) {
    throw httpError(403, 'SIN_PERMISO', 'Solo quien creó la reserva puede cancelarla');
  }
  if (reserva.estado !== 'Pendiente') {
    throw httpError(409, 'SOLO_PENDIENTE', 'Solo se pueden cancelar reservas pendientes');
  }
  db.prepare("UPDATE reservas SET estado = 'Cancelada' WHERE id = ?").run(reserva.id);
  const fila = db.prepare(`${LISTA} WHERE r.id = ?`).get(reserva.id);
  ok(res, { reserva: fila });
}));

module.exports = router;
