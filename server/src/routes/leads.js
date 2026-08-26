'use strict';

const express = require('express');
const { db } = require('../db');
const { validar, ahoraMs } = require('../util');
const { ok, wrap, httpError, rateLimit } = require('../middleware');

const router = express.Router();

// Rate-limit público: 5 solicitudes por hora por IP.
const limitadorLeads = rateLimit({ ventanaMs: 60 * 60 * 1000, max: 5 });

// POST /api/leads — público, con honeypot "website" que debe llegar vacío.
router.post('/', limitadorLeads, wrap(async (req, res) => {
  // Honeypot: si el campo oculto viene lleno es un bot → rechazo sin guardar.
  const cuerpo = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const website = typeof cuerpo.website === 'string' ? cuerpo.website.trim() : '';
  if (website !== '') {
    throw httpError(400, 'VALIDACION', 'Solicitud rechazada');
  }
  delete cuerpo.website;

  const v = validar(
    {
      conjunto: { tipo: 'string', requerido: true, max: 120 },
      ciudad: { tipo: 'string', requerido: true, max: 80 },
      unidades: { tipo: 'int', requerido: true, min: 1, max: 100000 },
      email: { tipo: 'email', requerido: true, max: 120 },
      celular: { tipo: 'string', requerido: true, max: 32 },
      plan: { tipo: 'string', requerido: true, max: 40 },
      contacto_nombre: { tipo: 'string', requerido: true, max: 120 },
    },
    req.body
  );
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);
  const d = v.valores;

  db.prepare(
    'INSERT INTO leads(conjunto,ciudad,unidades,email,celular,plan,contacto_nombre,creado_en) VALUES(?,?,?,?,?,?,?,?)'
  ).run(d.conjunto, d.ciudad, d.unidades, d.email, d.celular, d.plan, d.contacto_nombre, ahoraMs());

  ok(res, { mensaje: 'Gracias, un asesor te contactará pronto.' }, 201);
}));

module.exports = router;
