'use strict';

const crypto = require('crypto');
const express = require('express');
const { db } = require('../db');
const { validar, ahoraMs, sha256 } = require('../util');
const { ok, wrap, httpError, auditar, requireAuth, requireRole, unidadLabel, rateLimit } = require('../middleware');
const config = require('../config');

const router = express.Router();

const ROLES_RESIDENTE = ['copropietario', 'arrendatario'];

// Webhook de pasarela: público, autenticado por firma. Límite generoso pero acotado.
const limitadorWebhook = rateLimit({ ventanaMs: 60000, max: 120 });

const LISTA = `
  SELECT p.id, p.unidad_id, (u.torre || '-' || u.apto) AS unidad,
         p.concepto, p.periodo, p.valor, p.estado, p.metodo,
         p.referencia, p.fecha_pago, p.registrado_por, r.nombre AS registrado_nombre
  FROM pagos p
  JOIN unidades u ON u.id = p.unidad_id
  LEFT JOIN usuarios r ON r.id = p.registrado_por`;

router.get('/', requireAuth, wrap(async (req, res) => {
  const esStaff = req.usuario.rol === 'administrador' || req.usuario.rol === 'consejo';
  let filas;
  if (esStaff) {
    filas = db.prepare(`${LISTA} ORDER BY p.periodo DESC, unidad`).all();
  } else {
    if (!req.usuario.unidad_id) return ok(res, { pagos: [] });
    filas = db
      .prepare(`${LISTA} WHERE p.unidad_id = ? ORDER BY p.periodo DESC`)
      .all(req.usuario.unidad_id);
  }
  ok(res, { pagos: filas });
}));

// Pago SIMULADO: marca la cuota pendiente de la unidad del usuario como Pagada.
// Se desactiva solo cuando la pasarela real está configurada (evita pagos gratis).
router.post('/pse', requireAuth, requireRole(...ROLES_RESIDENTE), wrap(async (req, res) => {
  if (config.PAGOS_WOMPI_ACTIVO || config.PAYMENTS_PROVIDER === 'wompi') {
    throw httpError(409, 'PAGO_REAL_ACTIVO', 'El pago simulado está desactivado: usa el flujo de pasarela real (/api/pagos/pse/iniciar)');
  }
  const v = validar({ periodo: { tipo: 'mes', requerido: true } }, req.body);
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);
  const { periodo } = v.valores;

  const unidadId = req.usuario.unidad_id;
  if (!unidadId) throw httpError(409, 'SIN_UNIDAD', 'Tu usuario no tiene una unidad asociada');

  const ip = req.socket.remoteAddress || null;

  const pago = db.transaction(() => {
    const pendiente = db
      .prepare("SELECT * FROM pagos WHERE unidad_id = ? AND periodo = ? AND estado = 'Pendiente'")
      .get(unidadId, periodo);
    if (!pendiente) {
      throw httpError(409, 'SIN_CUOTA_PENDIENTE', `No hay una cuota pendiente para el periodo ${periodo}`);
    }
    const referencia = `PG-${10000 + Math.floor(Math.random() * 89999)}`;
    db.prepare(
      "UPDATE pagos SET estado = 'Pagado', metodo = 'PSE', referencia = ?, fecha_pago = ?, registrado_por = ? WHERE id = ?"
    ).run(referencia, ahoraMs(), req.usuario.id, pendiente.id);

    auditar(req.usuario.id, 'pago_pse', `pago=${pendiente.id} periodo=${periodo} ref=${referencia}`, ip);
    return db.prepare(`${LISTA} WHERE p.id = ?`).get(pendiente.id);
  })();

  ok(res, { pago });
}));

// Asignación manual de cuota (admin): por documento o usuario_id.
router.post('/asignar', requireAuth, requireRole('administrador'), wrap(async (req, res) => {
  const v = validar(
    {
      documento: { tipo: 'string', requerido: false, max: 20 },
      usuario_id: { tipo: 'int', requerido: false, min: 1 },
      periodo: { tipo: 'mes', requerido: true },
      concepto: { tipo: 'string', requerido: false, defecto: 'Administración', max: 80 },
      valor: { tipo: 'int', requerido: false, defecto: 250000, min: 1000, max: 100000000 },
    },
    req.body
  );
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);
  const d = v.valores;

  let usuario = null;
  if (d.usuario_id !== undefined) {
    usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(d.usuario_id);
    if (!usuario) {
      const err = httpError(404, 'USUARIO_NO_REGISTRADO', `No se encontró un usuario con id ${d.usuario_id}`);
      err.documento = null;
      err.sugerencia = 'invitar';
      throw err;
    }
  } else if (d.documento) {
    const doc = d.documento.trim();
    if (doc.length < 5 || doc.length > 20) {
      throw httpError(400, 'VALIDACION', 'El documento debe tener entre 5 y 20 caracteres');
    }
    usuario = db.prepare('SELECT * FROM usuarios WHERE documento = ?').get(doc);
    if (!usuario) {
      // El frontend detecta este caso por status 404 + texto del mensaje.
      const err = httpError(
        404,
        'USUARIO_NO_REGISTRADO',
        `No se encontró un usuario registrado con el documento ${doc}`
      );
      err.documento = doc;
      err.sugerencia = 'invitar';
      throw err;
    }
  } else {
    throw httpError(400, 'VALIDACION', 'Debes indicar documento o usuario_id');
  }

  if (!usuario.unidad_id) {
    throw httpError(400, 'SIN_UNIDAD', 'El usuario no tiene una unidad asociada');
  }

  const ip = req.socket.remoteAddress || null;
  let creado = false;
  const pago = db.transaction(() => {
    const existente = db
      .prepare('SELECT * FROM pagos WHERE unidad_id = ? AND periodo = ?')
      .get(usuario.unidad_id, d.periodo);
    if (existente && existente.estado === 'Pagado') {
      throw httpError(409, 'PERIODO_PAGADO', `El periodo ${d.periodo} ya está pagado para esta unidad`);
    }
    if (existente) {
      db.prepare('UPDATE pagos SET concepto = ?, valor = ?, registrado_por = ? WHERE id = ?').run(
        d.concepto,
        d.valor,
        req.usuario.id,
        existente.id
      );
    } else {
      creado = true;
      db.prepare(
        "INSERT INTO pagos(unidad_id,concepto,periodo,valor,estado,metodo,referencia,fecha_pago,registrado_por) VALUES(?,?,?,?,'Pendiente','Manual',NULL,NULL,?)"
      ).run(usuario.unidad_id, d.concepto, d.periodo, d.valor, req.usuario.id);
    }

    auditar(
      req.usuario.id,
      'pago_asignado',
      `documento=${usuario.documento} unidad=${usuario.unidad_id} periodo=${d.periodo} valor=${d.valor}`,
      ip
    );
    return db.prepare(`${LISTA} WHERE p.unidad_id = ? AND p.periodo = ?`).get(usuario.unidad_id, d.periodo);
  })();

  ok(res, { pago }, creado ? 201 : 200);
}));

/* --------------------------------------------------------------------- */
/* Pasarela real Wompi — fases F2/F3/F4 (deploy/PSE-INTEGRACION.md)       */
/* --------------------------------------------------------------------- */

const TXN_COLS = `
  SELECT id, pago_id, unidad_id, periodo, referencia, monto_centavos, moneda,
         pasarela, txn_id_pasarela, estado, banco, creada_en, actualizada_en
  FROM transacciones_pse`;

// Expiración lazy: transacciones sin resolución final liberan la cuota.
function expirarVencidas() {
  const limite = ahoraMs() - config.PAGOS_TIMEOUT_MINUTOS * 60000;
  db.prepare(
    "UPDATE transacciones_pse SET estado = 'Expirada', actualizada_en = ? WHERE estado IN ('Creada','Pendiente') AND creada_en <= ?"
  ).run(ahoraMs(), limite);
}

function nuevaReferencia(pagoId) {
  return `PG-${pagoId}-${crypto.randomBytes(4).toString('hex')}`;
}

// F2 · Inicio de pago: crea transacción y URL de checkout firmada.
router.post('/pse/iniciar', requireAuth, requireRole(...ROLES_RESIDENTE), wrap(async (req, res) => {
  if (!config.PAGOS_WOMPI_ACTIVO) {
    throw httpError(409, 'PROVEEDOR_NO_CONFIGURADO', 'La pasarela real no está configurada (PAYMENTS_PROVIDER/llaves Wompi en .env)');
  }
  const v = validar({ periodo: { tipo: 'mes', requerido: true } }, req.body);
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);
  const { periodo } = v.valores;

  const unidadId = req.usuario.unidad_id;
  if (!unidadId) throw httpError(409, 'SIN_UNIDAD', 'Tu usuario no tiene una unidad asociada');

  expirarVencidas();
  const ip = req.socket.remoteAddress || null;

  // Reanudar si ya existe una transacción activa para esa cuota (doble clic).
  const activa = db
    .prepare(
      `SELECT t.* FROM transacciones_pse t JOIN pagos p ON p.id = t.pago_id
       WHERE p.unidad_id = ? AND p.periodo = ? AND t.estado IN ('Creada','Pendiente')
       ORDER BY t.id DESC LIMIT 1`
    )
    .get(unidadId, periodo);
  if (activa) {
    return ok(res, { checkout_url: armarCheckoutUrl(activa), referencia: activa.referencia, reanudada: true });
  }

  const pendiente = db
    .prepare("SELECT * FROM pagos WHERE unidad_id = ? AND periodo = ? AND estado = 'Pendiente'")
    .get(unidadId, periodo);
  if (!pendiente) throw httpError(409, 'SIN_CUOTA_PENDIENTE', `No hay una cuota pendiente para el periodo ${periodo}`);

  const montoCentavos = pendiente.valor * 100;

  let transaccion;
  db.transaction(() => {
    let info;
    for (let intento = 0; intento < 3; intento++) {
      try {
        const ref = nuevaReferencia(pendiente.id); // única por diseño + UNIQUE en BD
        info = db
          .prepare(
            `INSERT INTO transacciones_pse(pago_id,unidad_id,periodo,referencia,monto_centavos,moneda,pasarela,estado,creada_en,actualizada_en)
             VALUES(?,?,?,?,?,'COP','wompi','Creada',?,?)`
          )
          .run(pendiente.id, unidadId, periodo, ref, montoCentavos, ahoraMs(), ahoraMs());
        break;
      } catch (e) {
        if (!(e && typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT'))) throw e;
        if (intento === 2) throw httpError(500, 'REFERENCIA_DUPLICADA', 'No fue posible generar una referencia única');
      }
    }
    transaccion = db.prepare(`${TXN_COLS} WHERE id = ?`).get(info.lastInsertRowid);
    auditar(req.usuario.id, 'pago_pse_iniciado', `pago=${pendiente.id} periodo=${periodo} ref=${transaccion.referencia} centavos=${montoCentavos}`, ip);
  })();

  ok(res, { checkout_url: armarCheckoutUrl(transaccion), referencia: transaccion.referencia }, 201);
}));

// URL de checkout firmada con el monto EXACTO de la BD (el cliente no lo altera).
function armarCheckoutUrl(t) {
  const firma = sha256(`${t.referencia}${t.monto_centavos}${t.moneda}${config.WOMPI_INTEGRITY_SECRET}`);
  const params = new URLSearchParams({
    'public-key': config.WOMPI_PUBLIC_KEY,
    currency: t.moneda,
    'amount-in-cents': String(t.monto_centavos),
    reference: t.referencia,
    'signature:integrity': firma,
  });
  if (config.APP_PUBLIC_BASE_URL) params.set('redirect-url', `${config.APP_PUBLIC_BASE_URL}/residente.html?pse=retorno`);
  return `${config.WOMPI_CHECKOUT_BASE}?${params.toString()}`;
}

// F4 · Estado local de una transacción (la página de retorno consulta esto).
router.get('/pse/:referencia/estado', requireAuth, wrap(async (req, res) => {
  expirarVencidas();
  const t = db.prepare(`${TXN_COLS} WHERE referencia = ?`).get(String(req.params.referencia));
  if (!t) throw httpError(404, 'NO_ENCONTRADO', 'Transacción no encontrada');
  const esStaff = req.usuario.rol === 'administrador' || req.usuario.rol === 'consejo';
  if (!esStaff && req.usuario.unidad_id !== t.unidad_id) {
    throw httpError(403, 'SIN_PERMISO', 'Esta transacción pertenece a otra unidad');
  }
  ok(res, { transaccion: { ...t, raw_evento: undefined }, simulado: false });
}));

/* --------------------------- Webhook Wompi (F3) ------------------------ */

// Estructura esperada del evento transaction.updated:
// { event:"transaction.updated", data:{transaction:{id,status,amount_in_cents,reference,...}},
//   sent_at, timestamp, signature:{properties:[...], checksum:"..."} }
//
// checksum = SHA256(valor1+valor2+...+timestamp+WOMPI_EVENTS_SECRET), hex MAYÚSCULAS.

function valorRuta(objeto, ruta) {
  return ruta.split('.').reduce((acc, parte) => (acc == null ? acc : acc[parte]), objeto);
}

function checksumValido(evento) {
  if (!evento || !evento.signature || !Array.isArray(evento.signature.properties)) return false;
  const valores = evento.signature.properties.map((p) => String(valorRuta(evento.data ?? evento, p) ?? ''));
  const calculado = sha256(valores.join('') + String(evento.timestamp) + config.WOMPI_EVENTS_SECRET).toUpperCase();
  return calculado === String(evento.signature.checksum || '').toUpperCase();
}

router.post('/webhook/wompi', limitadorWebhook, wrap(async (req, res) => {
  const ip = req.socket.remoteAddress || null;
  const evento = req.body;

  if (!checksumValido(evento)) {
    auditar(null, 'webhook_firma_invalida', `ip=${ip}`, ip);
    return res.status(401).json({ ok: false, error: { code: 'FIRMA_INVALIDA', message: 'Checksum inválido' } });
  }
  if (evento.event !== 'transaction.updated') {
    return res.json({ ok: true, ignorado: `evento_no_gestionado:${evento.event}` });
  }

  const txn = (evento.data && evento.data.transaction) || {};
  const referencia = String(txn.reference || '');
  const txnId = String(txn.id || '');
  const estadoPasarela = String(txn.status || '').toUpperCase();

  const t = db.prepare('SELECT * FROM transacciones_pse WHERE referencia = ?').get(referencia);
  if (!t) {
    auditar(null, 'webhook_referencia_desconocida', `ref=${referencia} txn=${txnId}`, ip);
    return res.json({ ok: true, ignorado: 'referencia_desconocida' });
  }

  // Idempotencia por txn_id: reentregas del mismo evento → sin doble efecto.
  if (t.txn_id_pasarela === txnId && ['Aprobada', 'Rechazada', 'Anulada'].includes(t.estado)) {
    return res.json({ ok: true, idempotente: true, estado: t.estado });
  }
  if (['Aprobada', 'Rechazada', 'Anulada'].includes(t.estado)) {
    auditar(null, 'webhook_conflicto_estado', `ref=${referencia} txn_nueva=${txnId} estado_local=${t.estado}`, ip);
    return res.json({ ok: true, ignorado: 'transaccion_ya_terminal' });
  }

  // Verificación de monto contra NUESTRA BD: nunca confiar solo en la pasarela.
  if (Number(txn.amount_in_cents) !== Number(t.monto_centavos)) {
    auditar(null, 'webhook_monto_inconsistente', `ref=${referencia} esperado=${t.monto_centavos} recibido=${txn.amount_in_cents}`, ip);
    return res.status(200).json({ ok: false, error: { code: 'MONTO_INCONSISTENTE' } });
  }

  const crudo = JSON.stringify(evento).slice(0, 20000);

  db.transaction(() => {
    if (estadoPasarela === 'APPROVED') {
      db.prepare(
        "UPDATE transacciones_pse SET estado='Aprobada', txn_id_pasarela=?, banco=?, raw_evento=?, actualizada_en=? WHERE id=?"
      ).run(txnId, txn.payment_method?.extra?.bank_name || null, crudo, ahoraMs(), t.id);
      db.prepare(
        "UPDATE pagos SET estado='Pagado', metodo='PSE', referencia=?, fecha_pago=?, registrado_por=NULL WHERE id=? AND estado='Pendiente'"
      ).run(t.referencia, ahoraMs(), t.pago_id);
    } else if (estadoPasarela === 'DECLINED' || estadoPasarela === 'ERROR') {
      db.prepare(
        "UPDATE transacciones_pse SET estado='Rechazada', txn_id_pasarela=?, raw_evento=?, actualizada_en=? WHERE id=?"
      ).run(txnId, crudo, ahoraMs(), t.id);
    } else if (estadoPasarela === 'VOIDED' || estadoPasarela === 'ANULLED') {
      db.prepare(
        "UPDATE transacciones_pse SET estado='Anulada', txn_id_pasarela=?, raw_evento=?, actualizada_en=? WHERE id=?"
      ).run(txnId, crudo, ahoraMs(), t.id);
    } else if (estadoPasarela === 'PENDING') {
      db.prepare(
        "UPDATE transacciones_pse SET estado='Pendiente', txn_id_pasarela=?, raw_evento=?, actualizada_en=? WHERE id=?"
      ).run(txnId, crudo, ahoraMs(), t.id);
    } else {
      return; // estado desconocido: no tocar nada
    }
    auditar(null, `webhook_txn_${estadoPasarela.toLowerCase()}`, `ref=${referencia} txn=${txnId}`, ip);
  })();

  res.json({ ok: true, estado_aplicado: estadoPasarela });
}));

module.exports = router;
