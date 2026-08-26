'use strict';

const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const { validar, hashPassword, ahoraMs } = require('../util');
const { ok, wrap, httpError, auditar, requireAuth, requireRole } = require('../middleware');

const router = express.Router();

const ROLES = ['administrador', 'consejo', 'porteria', 'copropietario', 'arrendatario'];
const TIPOS_DOC = ['CC', 'CE', 'TI', 'PA'];
const ESTADOS = ['Activo', 'Suspendido', 'Pendiente aprobación', 'Rechazado'];

const LISTA = `
  SELECT u.id, u.nombre, u.tipo_doc, u.documento, u.email, u.celular, u.rol, u.estado,
         u.unidad_id, u.debe_cambiar_clave, u.creado_en,
         (SELECT (x.torre || '-' || x.apto) FROM unidades x WHERE x.id = u.unidad_id) AS unidad
  FROM usuarios u`;

router.get('/', requireAuth, requireRole('administrador', 'consejo'), (req, res) => {
  const filas = db.prepare(`${LISTA} ORDER BY u.nombre COLLATE NOCASE`).all();
  ok(res, { usuarios: filas.map((f) => ({ ...f, debe_cambiar_clave: !!f.debe_cambiar_clave })) });
});

router.post('/', requireAuth, requireRole('administrador'), wrap(async (req, res) => {
  const v = validar(
    {
      nombre: { tipo: 'string', requerido: true, max: 80 },
      tipo_doc: { tipo: 'enum', enum: TIPOS_DOC, defecto: 'CC' },
      documento: { tipo: 'string', requerido: true, max: 32 },
      email: { tipo: 'email', requerido: false, max: 120 },
      celular: { tipo: 'string', requerido: false, max: 32 },
      rol: { tipo: 'enum', enum: ROLES, requerido: true },
      unidad_id: { tipo: 'int', requerido: false, min: 1 },
    },
    req.body
  );
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);
  const d = v.valores;

  if (db.prepare('SELECT id FROM usuarios WHERE documento = ?').get(d.documento)) {
    throw httpError(409, 'DOCUMENTO_EXISTE', 'Ya existe un usuario con ese documento');
  }
  if (d.unidad_id && !db.prepare('SELECT id FROM unidades WHERE id = ?').get(d.unidad_id)) {
    throw httpError(400, 'UNIDAD_INVALIDA', 'La unidad indicada no existe');
  }

  // Password temporal aleatoria (12 caracteres); debe cambiarla en el primer ingreso.
  const passwordTemporal = crypto.randomBytes(6).toString('hex');
  const info = db
    .prepare(
      `INSERT INTO usuarios(nombre,tipo_doc,documento,email,celular,rol,unidad_id,password_hash,debe_cambiar_clave,creado_en)
       VALUES(?,?,?,?,?,?,?,?,1,?)`
    )
    .run(
      d.nombre,
      d.tipo_doc,
      d.documento,
      d.email || null,
      d.celular || null,
      d.rol,
      d.unidad_id || null,
      hashPassword(passwordTemporal),
      ahoraMs()
    );

  auditar(req.usuario.id, 'usuario_creado', `id=${info.lastInsertRowid} documento=${d.documento} rol=${d.rol}`, req.socket.remoteAddress);

  const creado = db.prepare(`${LISTA} WHERE u.id = ?`).get(info.lastInsertRowid);
  ok(res, { usuario: { ...creado, debe_cambiar_clave: !!creado.debe_cambiar_clave }, password_temporal: passwordTemporal }, 201);
}));

router.patch('/:id', requireAuth, requireRole('administrador'), wrap(async (req, res) => {
  const v = validar(
    {
      rol: { tipo: 'enum', enum: ROLES, requerido: false },
      estado: { tipo: 'enum', enum: ESTADOS, requerido: false },
      unidad_id: { tipo: 'int', requerido: false, min: 1 },
    },
    req.body
  );
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);
  const cambios = v.valores;
  if (Object.keys(cambios).length === 0) throw httpError(400, 'VALIDACION', 'No hay campos para actualizar');

  const objetivo = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(req.params.id));
  if (!objetivo) throw httpError(404, 'NO_ENCONTRADO', 'Usuario no encontrado');

  if (cambios.unidad_id && !db.prepare('SELECT id FROM unidades WHERE id = ?').get(cambios.unidad_id)) {
    throw httpError(400, 'UNIDAD_INVALIDA', 'La unidad indicada no existe');
  }

  const campos = [];
  const params = [];
  for (const [campo, valor] of Object.entries(cambios)) {
    campos.push(`${campo} = ?`);
    params.push(valor === undefined ? null : campo === 'unidad_id' && valor === undefined ? null : valor);
  }
  params.push(objetivo.id);
  db.prepare(`UPDATE usuarios SET ${campos.join(', ')} WHERE id = ?`).run(...params);

  auditar(req.usuario.id, 'usuario_actualizado', `id=${objetivo.id} ${JSON.stringify(cambios)}`, req.socket.remoteAddress);

  const fila = db.prepare(`${LISTA} WHERE u.id = ?`).get(objetivo.id);
  ok(res, { usuario: { ...fila, debe_cambiar_clave: !!fila.debe_cambiar_clave } });
}));

router.post('/:id/reset-password', requireAuth, requireRole('administrador'), wrap(async (req, res) => {
  const objetivo = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(req.params.id));
  if (!objetivo) throw httpError(404, 'NO_ENCONTRADO', 'Usuario no encontrado');

  const temporal = crypto.randomBytes(6).toString('hex'); // 12 caracteres alfanuméricos
  db.prepare(
    'UPDATE usuarios SET password_hash = ?, debe_cambiar_clave = 1, failed_attempts = 0, locked_until = NULL WHERE id = ?'
  ).run(hashPassword(temporal), objetivo.id);

  // Revoca sesiones activas del usuario.
  db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(objetivo.id);

  auditar(req.usuario.id, 'password_reseteada', `id=${objetivo.id}`, req.socket.remoteAddress);
  ok(res, { password_temporal: temporal });
}));

module.exports = router;
