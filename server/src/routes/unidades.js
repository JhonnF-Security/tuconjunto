'use strict';

const express = require('express');
const { db } = require('../db');
const { validar } = require('../util');
const { ok, wrap, httpError, auditar, requireAuth, requireRole } = require('../middleware');

const router = express.Router();

// Lista de unidades con residente activo (propietario) y resumen por torre.
router.get('/', requireAuth, requireRole('administrador', 'consejo'), (req, res) => {
  const torre = typeof req.query.torre === 'string' ? req.query.torre.trim() : '';
  if (torre.length > 20) throw httpError(400, 'VALIDACION', 'El filtro torre es demasiado largo');

  const SQL_UNIDADES = `
    SELECT un.id, un.torre, un.apto, un.coeficiente,
           COALESCE(rp.nombre, ro.nombre) AS propietario_nombre,
           CASE
             WHEN rp.id IS NOT NULL THEN rp.estado
             WHEN ro.id IS NOT NULL THEN ro.estado
             ELSE NULL
           END AS estado_usuario
    FROM unidades un
    LEFT JOIN usuarios rp ON rp.id = (
      SELECT p.id FROM usuarios p
      WHERE p.unidad_id = un.id AND p.rol IN ('copropietario','arrendatario') AND p.estado = 'Activo'
      ORDER BY p.id LIMIT 1
    )
    LEFT JOIN usuarios ro ON ro.id = un.propietario_id`;

  const unidades = torre
    ? db.prepare(`${SQL_UNIDADES} WHERE un.torre = ? ORDER BY un.torre, LENGTH(un.apto), un.apto`).all(torre)
    : db.prepare(`${SQL_UNIDADES} ORDER BY un.torre, LENGTH(un.apto), un.apto`).all();

  const torres = db
    .prepare('SELECT torre, COUNT(*) AS total FROM unidades GROUP BY torre ORDER BY torre')
    .all();

  ok(res, { unidades, torres, total: unidades.length });
});

// Crear unidad (admin). UNIQUE(torre,apto) → 409 UNIDAD_EXISTE.
router.post('/', requireAuth, requireRole('administrador'), wrap(async (req, res) => {
  const v = validar(
    {
      torre: { tipo: 'string', requerido: true, max: 20 },
      apto: { tipo: 'string', requerido: true, max: 20 },
      coeficiente: { tipo: 'numero', requerido: false, min: 0, max: 1 },
    },
    req.body
  );
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);
  const d = v.valores;
  if (d.coeficiente !== undefined && d.coeficiente <= 0) {
    throw httpError(400, 'VALIDACION', 'El coeficiente debe ser mayor que 0');
  }

  const ip = req.socket.remoteAddress || null;

  if (db.prepare('SELECT id FROM unidades WHERE torre = ? AND apto = ?').get(d.torre, d.apto)) {
    throw httpError(409, 'UNIDAD_EXISTE', `La unidad ${d.torre}-${d.apto} ya existe`);
  }

  const info = db
    .prepare('INSERT INTO unidades(torre,apto,coeficiente) VALUES(?,?,?)')
    .run(d.torre, d.apto, d.coeficiente === undefined ? null : d.coeficiente);

  auditar(req.usuario.id, 'unidad_creada', `torre=${d.torre} apto=${d.apto}`, ip);

  const unidad = db.prepare('SELECT id,torre,apto,coeficiente FROM unidades WHERE id = ?').get(info.lastInsertRowid);
  ok(res, { unidad }, 201);
}));

module.exports = router;
