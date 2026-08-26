'use strict';

const express = require('express');
const { db } = require('../db');
const { ok, requireAuth, requireRole } = require('../middleware');

const router = express.Router();

// Cartera: pagos pendientes agrupados por unidad.
router.get('/', requireAuth, requireRole('administrador', 'consejo'), (req, res) => {
  const filas = db
    .prepare(
      `SELECT (u.torre || '-' || u.apto) AS unidad,
              SUM(p.valor) AS total_pendiente,
              COUNT(DISTINCT p.periodo) AS meses_mora
       FROM pagos p
       JOIN unidades u ON u.id = p.unidad_id
       WHERE p.estado = 'Pendiente'
       GROUP BY p.unidad_id
       ORDER BY meses_mora DESC, total_pendiente DESC`
    )
    .all();
  ok(res, { cartera: filas });
});

module.exports = router;
