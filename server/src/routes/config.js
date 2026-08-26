'use strict';

const express = require('express');
const { db } = require('../db');
const { validar, leerDataUrl, magicOk } = require('../util');
const { ok, wrap, httpError, auditar, requireAuth, requireRole, leerSeguridad } = require('../middleware');

const router = express.Router();

// Límites DUROS de los parámetros de seguridad (contrato v2).
const RANGOS_SEGURIDAD = {
  sesion_minutos: [10, 720],
  recordarme_horas: [1, 12],
  intentos_login: [3, 10],
  bloqueo_minutos: [5, 120],
  password_min: [6, 64],
};

const MAX_LOGO_BYTES = 500 * 1024; // 500 KB decodificados

function configPublica() {
  const fila = db.prepare("SELECT clave, valor FROM config WHERE clave IN ('nombre_conjunto','logo_dataurl')").all();
  const mapa = Object.fromEntries(fila.map((f) => [f.clave, f.valor]));
  return {
    nombre_conjunto: mapa.nombre_conjunto || 'TuConjunto',
    logo_dataurl: mapa.logo_dataurl || null,
  };
}

// Público: nombre del conjunto y logo.
router.get('/', (req, res) => {
  ok(res, configPublica());
});

router.put('/logo', requireAuth, requireRole('administrador'), wrap(async (req, res) => {
  const v = validar({ logo: { tipo: 'string', requerido: true, max: 800 * 1024 } }, req.body);
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);

  const dataUrl = leerDataUrl(v.valores.logo);
  if (!dataUrl || !dataUrl.mime.startsWith('image/')) {
    throw httpError(400, 'LOGO_INVALIDO', 'logo debe ser un dataURL de imagen');
  }
  if (dataUrl.mime !== 'image/jpeg' && dataUrl.mime !== 'image/png' && dataUrl.mime !== 'image/webp' && dataUrl.mime !== 'image/gif') {
    throw httpError(400, 'LOGO_INVALIDO', 'Formato de imagen no soportado');
  }
  if (!magicOk(dataUrl.mime, dataUrl.buffer)) {
    throw httpError(400, 'LOGO_INVALIDO', 'El archivo no corresponde a una imagen real');
  }
  if (dataUrl.buffer.length > MAX_LOGO_BYTES) {
    throw httpError(400, 'LOGO_GRANDE', 'El logo supera el máximo de 500 KB');
  }

  db.prepare(
    "INSERT INTO config(clave,valor) VALUES('logo_dataurl',?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor"
  ).run(v.valores.logo);

  ok(res, configPublica());
}));

/* -------------------- Parámetros de seguridad ----------------------- */

router.get('/seguridad', requireAuth, requireRole('administrador'), (req, res) => {
  // Crea los defaults si aún no existen en la tabla config.
  const actual = leerSeguridad();
  db.prepare(
    "INSERT INTO config(clave,valor) VALUES('seguridad',?) ON CONFLICT(clave) DO NOTHING"
  ).run(JSON.stringify(actual));
  ok(res, actual);
});

router.put('/seguridad', requireAuth, requireRole('administrador'), wrap(async (req, res) => {
  const cuerpo = req.body;
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) {
    throw httpError(400, 'VALIDACION', 'Cuerpo de la petición inválido');
  }
  const anterior = leerSeguridad();
  const nuevo = {};
  for (const campo of Object.keys(RANGOS_SEGURIDAD)) {
    const v = cuerpo[campo];
    if (v === undefined || v === null) nuevo[campo] = anterior[campo];
    else {
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        throw httpError(400, 'VALIDACION', `${campo} debe ser un número entero`);
      }
      if (campo === 'recordarme_horas' && v > 12) {
        throw httpError(400, 'VALIDACION', 'El recordarme no puede exceder 12 horas');
      }
      const [min, max] = RANGOS_SEGURIDAD[campo];
      if (v < min || v > max) {
        throw httpError(400, 'VALIDACION', `${campo} debe estar entre ${min} y ${max}`);
      }
      nuevo[campo] = v;
    }
  }
  for (const campo of Object.keys(cuerpo)) {
    if (!Object.prototype.hasOwnProperty.call(RANGOS_SEGURIDAD, campo)) {
      throw httpError(400, 'VALIDACION', `Campo no permitido: ${campo}`);
    }
  }

  db.prepare(
    "INSERT INTO config(clave,valor) VALUES('seguridad',?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor"
  ).run(JSON.stringify(nuevo));

  const cambios = {};
  for (const campo of Object.keys(RANGOS_SEGURIDAD)) {
    if (anterior[campo] !== nuevo[campo]) cambios[campo] = [anterior[campo], nuevo[campo]];
  }
  auditar(
    req.usuario.id,
    'config_seguridad',
    Object.keys(cambios).length ? JSON.stringify(cambios) : 'sin cambios',
    req.socket.remoteAddress
  );

  ok(res, nuevo);
}));

module.exports = router;
