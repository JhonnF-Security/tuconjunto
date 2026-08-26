'use strict';

const express = require('express');
const { db } = require('../db');
const { validar, ahoraMs } = require('../util');
const { ok, wrap, httpError, auditar, requireAuth, requireRole, unidadLabel, rateLimit } = require('../middleware');

const router = express.Router();

// Botón de pánico: máx 3 alertas por usuario cada 5 minutos (anti-spam).
const limitadorPanico = rateLimit({
  ventanaMs: 300000,
  max: 3,
  clave: (req) => String(req.usuario ? req.usuario.id : req.socket.remoteAddress),
});

router.get('/', requireAuth, requireRole('porteria', 'administrador'), wrap(async (req, res) => {
  const activas = req.query.activas === '1' || req.query.activas === 'true';
  const base = `
    SELECT a.id, a.usuario_id, u.nombre AS usuario_nombre, a.unidad, a.tipo,
           a.atendida, a.creada_en, a.atendida_por, p.nombre AS atendida_nombre, a.atendida_en
    FROM alertas a
    LEFT JOIN usuarios u ON u.id = a.usuario_id
    LEFT JOIN usuarios p ON p.id = a.atendida_por`;
  const filas = activas
    ? db.prepare(`${base} WHERE a.atendida = 0 ORDER BY a.creada_en DESC LIMIT 100`).all()
    : db.prepare(`${base} ORDER BY a.creada_en DESC LIMIT 100`).all();
  ok(res, { alertas: filas });
}));

// Botón de pánico: cualquier usuario autenticado; usa su unidad.
// I-2: tipo validado contra enum cerrado (solo 'panico', default 'panico').
router.post('/', requireAuth, limitadorPanico, wrap(async (req, res) => {
  let tipo = 'panico';
  if (req.body && Object.keys(req.body).length > 0) {
    const v = validar({ tipo: { tipo: 'enum', enum: ['panico'], requerido: false, defecto: 'panico' } }, req.body);
    if (!v.ok) throw httpError(400, 'VALIDACION', v.error);
    if (v.valores.tipo) tipo = v.valores.tipo;
  }
  const unidad = unidadLabel(req.usuario.unidad_id) || 'N/D';
  // Dedup: si la misma unidad ya tiene una alerta activa reciente (<5 min), no duplicar.
  const activaReciente = db
    .prepare("SELECT id FROM alertas WHERE atendida = 0 AND unidad = ? AND tipo = ? AND creada_en > ? LIMIT 1")
    .get(unidad, tipo, ahoraMs() - 300000);
  if (activaReciente) {
    const existente = db.prepare('SELECT * FROM alertas WHERE id = ?').get(activaReciente.id);
    return ok(res, { alerta: existente, deduplicada: true }, 200);
  }
  const info = db
    .prepare("INSERT INTO alertas(usuario_id,unidad,tipo,atendida,creada_en,atendida_por,atendida_en) VALUES(?,?,?,0,?,NULL,NULL)")
    .run(req.usuario.id, unidad, tipo, ahoraMs());
  const fila = db.prepare('SELECT * FROM alertas WHERE id = ?').get(info.lastInsertRowid);
  ok(res, { alerta: fila }, 201);
}));

router.patch('/:id/atender', requireAuth, requireRole('porteria', 'administrador'), wrap(async (req, res) => {
  const alerta = db.prepare('SELECT * FROM alertas WHERE id = ?').get(Number(req.params.id));
  if (!alerta) throw httpError(404, 'NO_ENCONTRADO', 'Alerta no encontrada');
  if (alerta.atendida) return ok(res, { alerta });

  db.prepare('UPDATE alertas SET atendida = 1, atendida_por = ?, atendida_en = ? WHERE id = ?').run(
    req.usuario.id,
    ahoraMs(),
    alerta.id
  );
  auditar(req.usuario.id, 'alerta_atendida', `alerta=${alerta.id}`, req.socket.remoteAddress);

  const fila = db.prepare('SELECT * FROM alertas WHERE id = ?').get(alerta.id);
  ok(res, { alerta: fila });
}));

module.exports = router;
