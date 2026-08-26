'use strict';

const express = require('express');
const { db } = require('../db');
const { ok, requireAuth, requireRole } = require('../middleware');

const router = express.Router();

router.get('/', requireAuth, requireRole('administrador', 'consejo'), (req, res) => {
  const ahora = new Date();
  const mes = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}`;
  const hoy = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}-${String(ahora.getDate()).padStart(2, '0')}`;
  const inicioHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()).getTime();
  const finHoy = inicioHoy + 24 * 60 * 60 * 1000;

  const recaudado_mes = db
    .prepare("SELECT COALESCE(SUM(valor),0) AS t FROM pagos WHERE periodo = ? AND estado = 'Pagado'")
    .get(mes).t;
  const pendiente_mes = db
    .prepare("SELECT COALESCE(SUM(valor),0) AS t FROM pagos WHERE periodo = ? AND estado = 'Pendiente'")
    .get(mes).t;
  const totalMes = recaudado_mes + pendiente_mes;

  const morosos = db
    .prepare("SELECT COUNT(DISTINCT unidad_id) AS n FROM pagos WHERE periodo = ? AND estado = 'Pendiente'")
    .get(mes).n;
  const reservas_hoy = db
    .prepare("SELECT COUNT(*) AS n FROM reservas WHERE fecha = ? AND estado IN ('Confirmada','Pendiente')")
    .get(hoy).n;
  const tickets_abiertos = db.prepare("SELECT COUNT(*) AS n FROM pqrs WHERE estado != 'Resuelto'").get().n;
  const visitas_dentro = db
    .prepare('SELECT COUNT(*) AS n FROM visitas WHERE salida IS NULL AND entrada >= ? AND entrada < ?')
    .get(inicioHoy, finHoy).n;

  ok(res, {
    mes,
    recaudado_mes,
    pendiente_mes,
    pct_recaudo: totalMes > 0 ? Math.round((recaudado_mes / totalMes) * 100) : 0,
    morosos,
    reservas_hoy,
    tickets_abiertos,
    visitas_dentro,
  });
});

module.exports = router;
