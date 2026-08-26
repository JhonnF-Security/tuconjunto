'use strict';

const express = require('express');
const { db } = require('../db');
const { validar, ahoraMs, leerDataUrl, magicOk } = require('../util');
const { ok, wrap, httpError, requireAuth, requireRole } = require('../middleware');

const router = express.Router();

const TIPOS_VISITA = ['Visitante', 'Domiciliario', 'Proveedor', 'Contratista'];
const MAX_FOTO_BYTES = 300 * 1024; // 300 KB decodificados

// Valida un dataURL de imagen: prefijo, magic bytes JPEG/PNG y tamaño ≤300KB.
function validarFoto(valor, campo) {
  const dataUrl = leerDataUrl(valor);
  if (!dataUrl) throw httpError(400, 'FOTO_INVALIDA', `${campo} no es un dataURL de imagen válido`);
  if (dataUrl.mime !== 'image/jpeg' && dataUrl.mime !== 'image/png') {
    throw httpError(400, 'FOTO_INVALIDA', `${campo} debe ser una imagen JPEG o PNG`);
  }
  if (!magicOk(dataUrl.mime, dataUrl.buffer)) {
    throw httpError(400, 'FOTO_INVALIDA', `${campo} no corresponde a un archivo ${dataUrl.mime === 'image/jpeg' ? 'JPEG' : 'PNG'} real`);
  }
  if (dataUrl.buffer.length > MAX_FOTO_BYTES) {
    throw httpError(400, 'FOTO_GRANDE', `${campo} supera el máximo de 300 KB`);
  }
}

function visitaPublica(fila) {
  return {
    id: fila.id,
    nombre: fila.nombre,
    documento: fila.documento,
    tipo: fila.tipo,
    unidad_destino: fila.unidad_destino,
    motivo: fila.motivo,
    tiene_foto_rostro: !!fila.foto_rostro,
    tiene_foto_cedula: !!fila.foto_cedula,
    entrada: fila.entrada,
    salida: fila.salida || null,
    registrada_por: fila.registrada_por,
  };
}

router.get('/', requireAuth, requireRole('porteria', 'administrador'), wrap(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
  let filas;
  if (q) {
    const patron = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    filas = db
      .prepare(
        `SELECT * FROM visitas
         WHERE nombre LIKE ? ESCAPE '\\' OR documento LIKE ? ESCAPE '\\' OR unidad_destino LIKE ? ESCAPE '\\'
         ORDER BY entrada DESC LIMIT 200`
      )
      .all(patron, patron, patron);
  } else {
    filas = db.prepare('SELECT * FROM visitas ORDER BY entrada DESC LIMIT 200').all();
  }
  ok(res, { visitas: filas.map(visitaPublica) });
}));

router.post('/', requireAuth, requireRole('porteria'), wrap(async (req, res) => {
  const v = validar(
    {
      nombre: { tipo: 'string', requerido: true, max: 80 },
      documento: { tipo: 'string', requerido: true, max: 32 },
      tipo: { tipo: 'enum', enum: TIPOS_VISITA, requerido: true },
      unidad_destino: { tipo: 'string', requerido: true, max: 40 },
      motivo: { tipo: 'string', requerido: false, max: 200 },
      foto_rostro: { tipo: 'string', requerido: false, max: 500000 },
      foto_cedula: { tipo: 'string', requerido: false, max: 500000 },
    },
    req.body
  );
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);
  const d = v.valores;

  if (d.foto_rostro) validarFoto(d.foto_rostro, 'foto_rostro');
  if (d.foto_cedula) validarFoto(d.foto_cedula, 'foto_cedula');

  const info = db
    .prepare(
      `INSERT INTO visitas(nombre,documento,tipo,unidad_destino,motivo,foto_rostro,foto_cedula,entrada,salida,registrada_por)
       VALUES(?,?,?,?,?,?,?,?,NULL,?)`
    )
    .run(
      d.nombre,
      d.documento,
      d.tipo,
      d.unidad_destino.toUpperCase(),
      d.motivo || null,
      d.foto_rostro || null,
      d.foto_cedula || null,
      ahoraMs(),
      req.usuario.id
    );

  const fila = db.prepare('SELECT * FROM visitas WHERE id = ?').get(info.lastInsertRowid);
  ok(res, { visita: visitaPublica(fila) }, 201);
}));

router.patch('/:id/salida', requireAuth, requireRole('porteria'), wrap(async (req, res) => {
  const visita = db.prepare('SELECT * FROM visitas WHERE id = ?').get(Number(req.params.id));
  if (!visita) throw httpError(404, 'NO_ENCONTRADO', 'Visita no encontrada');
  if (visita.salida) throw httpError(409, 'YA_SALIO', 'La salida ya fue registrada');

  db.prepare('UPDATE visitas SET salida = ? WHERE id = ?').run(ahoraMs(), visita.id);
  const fila = db.prepare('SELECT * FROM visitas WHERE id = ?').get(visita.id);
  ok(res, { visita: visitaPublica(fila) });
}));

module.exports = router;
