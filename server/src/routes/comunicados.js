'use strict';

const express = require('express');
const { db } = require('../db');
const { validar, ahoraMs } = require('../util');
const { ok, wrap, httpError, requireAuth, requireRole } = require('../middleware');

const router = express.Router();

const LISTA = `
  SELECT c.id, c.titulo, c.cuerpo, c.categoria, c.autor_id, u.nombre AS autor_nombre, c.creado_en
  FROM comunicados c
  LEFT JOIN usuarios u ON u.id = c.autor_id`;

router.get('/', requireAuth, (req, res) => {
  const filas = db.prepare(`${LISTA} ORDER BY c.creado_en DESC`).all();
  ok(res, { comunicados: filas });
});

router.post('/', requireAuth, requireRole('administrador'), wrap(async (req, res) => {
  const v = validar(
    {
      titulo: { tipo: 'string', requerido: true, max: 150 },
      cuerpo: { tipo: 'string', requerido: true, max: 5000 },
      categoria: { tipo: 'string', requerido: true, max: 40 },
    },
    req.body
  );
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);
  const d = v.valores;

  const info = db
    .prepare('INSERT INTO comunicados(titulo,cuerpo,categoria,autor_id,creado_en) VALUES(?,?,?,?,?)')
    .run(d.titulo, d.cuerpo, d.categoria, req.usuario.id, ahoraMs());

  const fila = db.prepare(`${LISTA} WHERE c.id = ?`).get(info.lastInsertRowid);
  ok(res, { comunicado: fila }, 201);
}));

module.exports = router;
