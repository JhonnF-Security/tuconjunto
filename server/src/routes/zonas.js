'use strict';

const express = require('express');
const { db } = require('../db');
const { ok, requireAuth } = require('../middleware');

const router = express.Router();

// GET /api/zonas — lista de zonas comunes (cualquier usuario autenticado).
router.get('/', requireAuth, (req, res) => {
  const zonas = db
    .prepare('SELECT id, nombre, capacidad, costo_hora, activa FROM zonas ORDER BY nombre COLLATE NOCASE')
    .all();
  ok(res, { zonas });
});

module.exports = router;
