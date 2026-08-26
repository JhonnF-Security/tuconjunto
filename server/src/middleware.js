'use strict';

const crypto = require('crypto');
const { db } = require('./db');
const { sha256, ahoraMs } = require('./util');

/* ------------------------------------------------------------------ */
/* Utilidades base                                                     */
/* ------------------------------------------------------------------ */

function leerCookie(req, nombre) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const parte of header.split(';')) {
    const i = parte.indexOf('=');
    if (i === -1) continue;
    if (parte.slice(0, i).trim() === nombre) {
      try {
        return decodeURIComponent(parte.slice(i + 1).trim());
      } catch {
        return parte.slice(i + 1).trim();
      }
    }
  }
  return null;
}

function ipDe(req) {
  // Con trust proxy configurado, req.ip respeta X-Forwarded-For.
  return req.ip || (req.socket && req.socket.remoteAddress) || 'desconocida';
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function httpError(status, code, message) {
  return new HttpError(status, code, message);
}

// Envuelve handlers async para que los rechazos lleguen al errorHandler.
function wrap(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function ok(res, data, status = 200) {
  res.status(status).json({ ok: true, data });
}

/* ------------------------------------------------------------------ */
/* Auditoría                                                           */
/* ------------------------------------------------------------------ */

function registrarAuditoria(usuarioId, accion, detalle, ip) {
  try {
    db.prepare('INSERT INTO auditoria(usuario_id,accion,detalle,ip,creado_en) VALUES(?,?,?,?,?)').run(
      usuarioId === undefined ? null : usuarioId,
      String(accion),
      detalle === undefined ? null : typeof detalle === 'string' ? detalle : JSON.stringify(detalle),
      ip || null,
      ahoraMs()
    );
  } catch (e) {
    console.error('[auditoria] no se pudo registrar:', e.message);
  }
}

function auditor(dbase) {
  return (usuario_id, accion, detalle, ip) => registrarAuditoria(usuario_id, accion, detalle, ip);
}
const auditar = auditor(db);

/* ------------------------------------------------------------------ */
/* Autenticación / autorización                                        */
/* ------------------------------------------------------------------ */

const PERFIL_COLS = `u.id, u.nombre, u.tipo_doc, u.documento, u.email, u.celular,
  u.rol, u.estado, u.unidad_id, u.debe_cambiar_clave`;

function unidadLabel(unidadId) {
  if (!unidadId) return null;
  const u = db.prepare('SELECT torre, apto FROM unidades WHERE id = ?').get(unidadId);
  return u ? `${u.torre}-${u.apto}` : null;
}

function perfilUsuario(u) {
  return {
    id: u.id,
    nombre: u.nombre,
    tipo_doc: u.tipo_doc,
    documento: u.documento,
    email: u.email || null,
    celular: u.celular || null,
    rol: u.rol,
    estado: u.estado,
    unidad: unidadLabel(u.unidad_id),
    unidad_id: u.unidad_id || null,
    debe_cambiar_clave: !!u.debe_cambiar_clave,
  };
}

// Limpia sesiones expiradas de un usuario (regla de seguridad §10).
function limpiarSesionesExpiradas(usuarioId, ahora) {
  db.prepare('DELETE FROM sesiones WHERE usuario_id = ? AND expira_en <= ?').run(usuarioId, ahora);
}

/* ------------------------------------------------------------------ */
/* Config dinámica de seguridad (tabla config, clave "seguridad")      */
/* ------------------------------------------------------------------ */

const SEGURIDAD_DEFAULT = {
  sesion_minutos: 60,
  recordarme_horas: 12,
  intentos_login: 5,
  bloqueo_minutos: 15,
  password_min: 8,
};

// Se lee en CADA uso (sin cache larga) para aplicar cambios al instante.
function leerSeguridad() {
  try {
    const fila = db.prepare("SELECT valor FROM config WHERE clave = 'seguridad'").get();
    if (!fila) return { ...SEGURIDAD_DEFAULT };
    const parsed = JSON.parse(fila.valor);
    const salida = { ...SEGURIDAD_DEFAULT };
    for (const clave of Object.keys(SEGURIDAD_DEFAULT)) {
      const v = Number(parsed && parsed[clave]);
      if (Number.isInteger(v)) salida[clave] = v;
    }
    return salida;
  } catch {
    return { ...SEGURIDAD_DEFAULT };
  }
}

function requireAuth(req, res, next) {
  const token = leerCookie(req, 'tc_session');
  if (!token) {
    return res.status(401).json({ ok: false, error: { code: 'NO_AUTH', message: 'No autenticado' } });
  }
  const ahora = ahoraMs();
  const fila = db
    .prepare(`SELECT s.expira_en, ${PERFIL_COLS} FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token_hash = ?`)
    .get(sha256(token));
  if (!fila) {
    return res.status(401).json({ ok: false, error: { code: 'NO_AUTH', message: 'Sesión inválida' } });
  }
  limpiarSesionesExpiradas(fila.id, ahora);
  if (fila.expira_en <= ahora) {
    return res.status(401).json({ ok: false, error: { code: 'SESION_EXPIRADA', message: 'Sesión expirada' } });
  }
  // Una cuenta que deja de estar Activa pierde sus sesiones de inmediato.
  if (fila.estado !== 'Activo') {
    db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(fila.id);
    return res.status(403).json({
      ok: false,
      error: { code: 'CUENTA_INACTIVA', message: 'Tu cuenta no está activa. Contacta a la administración.' },
    });
  }
  req.usuario = perfilUsuario(fila);
  req.usuarioIdInterno = fila.id;
  // Contrato v2: con contraseña temporal obligatoria, solo se permite /api/auth/*.
  if (
    fila.debe_cambiar_clave === 1 &&
    !String(req.originalUrl || '').startsWith('/api/auth')
  ) {
    return res.status(403).json({
      ok: false,
      error: {
        code: 'DEBE_CAMBIAR_CLAVE',
        message: 'Debes cambiar tu contraseña temporal antes de continuar',
      },
    });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.usuario) {
      return res.status(401).json({ ok: false, error: { code: 'NO_AUTH', message: 'No autenticado' } });
    }
    if (!roles.includes(req.usuario.rol)) {
      return res.status(403).json({ ok: false, error: { code: 'SIN_ROL', message: 'No tienes permisos para esta acción' } });
    }
    next();
  };
}

/* ------------------------------------------------------------------ */
/* Rate-limit en memoria                                               */
/* ------------------------------------------------------------------ */

const LIMITADORES = [];

function rateLimit({ ventanaMs, max, clave }) {
  const mapa = new Map();
  LIMITADORES.push(mapa);
  const temporizador = setInterval(() => {
    const ahoraLimpieza = Date.now();
    for (const [k, entrada] of mapa) {
      if (ahoraLimpieza > entrada.resetAt) mapa.delete(k);
    }
  }, Math.min(ventanaMs, 60000));
  if (typeof temporizador.unref === 'function') temporizador.unref();

  return function rateLimitMW(req, res, next) {
    const sufijo = clave ? clave(req) : '';
    const k = `${ipDe(req)}|${sufijo}`;
    const ahora = Date.now();
    let entrada = mapa.get(k);
    if (!entrada || ahora > entrada.resetAt) {
      entrada = { cuenta: 0, resetAt: ahora + ventanaMs };
      mapa.set(k, entrada);
    }
    entrada.cuenta += 1;
    if (entrada.cuenta > max) {
      return res
        .status(429)
        .json({ ok: false, error: { code: 'RATE_LIMIT', message: 'Demasiadas solicitudes. Intenta más tarde.' } });
    }
    next();
  };
}

/* ------------------------------------------------------------------ */
/* CSRF                                                                */
/* ------------------------------------------------------------------ */

function csrfMutaciones(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  // Los webhooks de pasarelas se autentican por firma (checksum), no por
  // sesión: no pueden enviar cabeceras X-Requested-With.
  if (String(req.path).startsWith('/api/pagos/webhook/')) return next();
  if (req.headers['x-requested-with'] !== 'fetch') {
    return res
      .status(403)
      .json({ ok: false, error: { code: 'CSRF', message: 'Petición rechazada: falta el encabezado X-Requested-With' } });
  }
  next();
}

/* ------------------------------------------------------------------ */
/* Cabeceras de seguridad (contrato §3) + CSP con nonce                */
/* ------------------------------------------------------------------ */

// script-src SIN 'unsafe-inline': todo <script> inline recibe nonce por request.
function construirCsp(nonce) {
  return (
    "default-src 'self'; img-src 'self' data: blob:; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    'font-src https://fonts.gstatic.com; ' +
    `script-src 'self' 'nonce-${nonce}'; ` +
    "connect-src 'self'"
  );
}

// Genera un nonce criptográfico por request y lo expone en res.locals.nonce.
function noncePorRequest(req, res, next) {
  res.locals = res.locals || {};
  res.locals.nonce = crypto.randomBytes(16).toString('hex');
  next();
}

// Inyecta el nonce en TODA etiqueta de apertura <script ...> (incluidas las
// externas con src, inofensivo) que aún no lo tenga. Los <script> del head
// quedan cubiertos porque se reescribe cada aparición de la etiqueta.
function inyectarNonceHtml(html, nonce) {
  if (!html || typeof html !== 'string' || !nonce) return html;
  return html.replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);
}

function seguridadHeaders(req, res, next) {
  const nonce = (res.locals && res.locals.nonce) || '';
  res.setHeader('Content-Security-Policy', construirCsp(nonce));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=()');
  // HSTS SOLO sobre conexiones seguras (detrás de proxy TLS exige trust proxy).
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

/* ------------------------------------------------------------------ */
/* Error handler central                                               */
/* ------------------------------------------------------------------ */

function errorHandler(err, req, res, _next) {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    console.warn(`[http ${err.status}] ${err.code}: ${err.message} — ${req.method} ${req.originalUrl}`);
    return res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message } });
  }
  // Cuerpo JSON malformado o de tipo escalar: error del cliente, no del servidor.
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large' || err instanceof SyntaxError)) {
    console.warn(`[parse] ${err.message} — ${req.method} ${req.originalUrl}`);
    return res
      .status(err.type === 'entity.too.large' ? 413 : 400)
      .json({ ok: false, error: { code: 'VALIDACION', message: 'Cuerpo de la petición inválido' } });
  }
  // Violaciones de unicidad u otras condiciones conocidas de SQLite.
  if (err && typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
    console.warn(`[sqlite] ${err.code}: ${err.message}`);
    return res
      .status(409)
      .json({ ok: false, error: { code: 'CONFLICTO', message: 'La operación entra en conflicto con un registro existente' } });
  }
  console.error('[error]', err);
  registrarAuditoria(null, 'error_interno', `${req.method} ${req.originalUrl}: ${err && err.message}`, ipDe(req));
  res.status(500).json({ ok: false, error: { code: 'INTERNO', message: 'Error interno del servidor' } });
}

module.exports = {
  leerCookie,
  ipDe,
  HttpError,
  httpError,
  wrap,
  ok,
  auditar,
  registrarAuditoria,
  auditor,
  requireAuth,
  requireRole,
  rateLimit,
  csrfMutaciones,
  noncePorRequest,
  inyectarNonceHtml,
  construirCsp,
  seguridadHeaders,
  errorHandler,
  perfilUsuario,
  unidadLabel,
  leerSeguridad,
  SEGURIDAD_DEFAULT,
};
