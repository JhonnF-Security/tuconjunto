'use strict';

const express = require('express');
const { db } = require('../db');
const { validar, ahoraMs, leerDataUrl, magicOk } = require('../util');
const { ok, wrap, httpError, requireAuth, requireRole } = require('../middleware');

const router = express.Router();

const MAX_DOC_BYTES = 2 * 1024 * 1024; // 2 MB decodificados
const MIMES_PERMITIDOS = ['application/pdf', 'image/jpeg', 'image/png'];

function validarContenido(valor) {
  const dataUrl = leerDataUrl(valor);
  if (!dataUrl) throw httpError(400, 'ARCHIVO_INVALIDO', 'contenido no es un dataURL válido');
  if (!MIMES_PERMITIDOS.includes(dataUrl.mime)) {
    throw httpError(400, 'ARCHIVO_INVALIDO', 'Solo se admiten archivos PDF, JPG o PNG');
  }
  if (!magicOk(dataUrl.mime, dataUrl.buffer)) {
    throw httpError(400, 'ARCHIVO_INVALIDO', 'El contenido no corresponde al tipo de archivo declarado');
  }
  if (dataUrl.buffer.length > MAX_DOC_BYTES) {
    throw httpError(400, 'ARCHIVO_GRANDE', 'El archivo supera el máximo de 2 MB');
  }
  return dataUrl;
}

router.get('/', requireAuth, (req, res) => {
  const filas = db
    .prepare(
      `SELECT d.id, d.nombre, d.tamano, d.mime, d.subido_por, u.nombre AS subido_nombre, d.creado_en
       FROM documentos d LEFT JOIN usuarios u ON u.id = d.subido_por
       ORDER BY d.creado_en DESC`
    )
    .all();
  ok(res, { documentos: filas });
});

router.post('/', requireAuth, requireRole('administrador'), wrap(async (req, res) => {
  const v = validar(
    {
      nombre: { tipo: 'string', requerido: true, max: 120 },
      contenido: { tipo: 'string', requerido: true, max: 4 * 1024 * 1024 },
    },
    req.body
  );
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);

  const dataUrl = validarContenido(v.valores.contenido);
  const info = db
    .prepare('INSERT INTO documentos(nombre,tamano,mime,contenido,subido_por,creado_en) VALUES(?,?,?,?,?,?)')
    .run(v.valores.nombre, dataUrl.buffer.length, dataUrl.mime, v.valores.contenido, req.usuario.id, ahoraMs());

  const fila = db
    .prepare('SELECT id, nombre, tamano, mime, subido_por, creado_en FROM documentos WHERE id = ?')
    .get(info.lastInsertRowid);
  ok(res, { documento: fila }, 201);
}));

router.get('/:id/descargar', requireAuth, wrap(async (req, res) => {
  const fila = db.prepare('SELECT * FROM documentos WHERE id = ?').get(Number(req.params.id));
  if (!fila) throw httpError(404, 'NO_ENCONTRADO', 'Documento no encontrado');

  const buffer = Buffer.from(fila.contenido.replace(/^data:[^,]+;base64,/, ''), 'base64');
  res.setHeader('Content-Type', fila.mime);
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="doc-${fila.id}"; filename*=UTF-8''${encodeURIComponent(fila.nombre)}`);
  res.send(buffer);
}));

module.exports = router;
