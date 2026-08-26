'use strict';

const express = require('express');
const { db } = require('../db');
const { ok, requireAuth, requireRole } = require('../middleware');

const router = express.Router();

// Estadísticas de comunidad para el panel admin/consejo.
router.get('/stats', requireAuth, requireRole('administrador', 'consejo'), (req, res) => {
  const contar = (sql) => db.prepare(sql).get().n;
  const estadosVigentes = "('Activo','Pendiente aprobación','Suspendido')";

  ok(res, {
    total: contar(`SELECT COUNT(*) AS n FROM usuarios WHERE estado IN ${estadosVigentes}`),
    copropietarios: contar(
      `SELECT COUNT(*) AS n FROM usuarios WHERE rol='copropietario' AND estado IN ${estadosVigentes}`
    ),
    arrendatarios: contar(
      `SELECT COUNT(*) AS n FROM usuarios WHERE rol='arrendatario' AND estado IN ${estadosVigentes}`
    ),
    pendientes: contar("SELECT COUNT(*) AS n FROM usuarios WHERE estado='Pendiente aprobación'"),
    suspendidos: contar("SELECT COUNT(*) AS n FROM usuarios WHERE estado='Suspendido'"),
    torres: contar('SELECT COUNT(DISTINCT torre) AS n FROM unidades'),
    unidades: contar('SELECT COUNT(*) AS n FROM unidades'),
    unidades_ocupadas: contar(`
      SELECT COUNT(*) AS n FROM unidades un
      WHERE un.propietario_id IS NOT NULL
         OR EXISTS(SELECT 1 FROM usuarios u WHERE u.unidad_id = un.id AND u.estado = 'Activo')
    `),
  });
});

module.exports = router;
