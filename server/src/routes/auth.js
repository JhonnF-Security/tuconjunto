'use strict';

const express = require('express');
const { db } = require('../db');
const { validar, hashPassword, verifyPassword, sha256, nuevoToken, ahoraMs } = require('../util');
const {
  ok,
  wrap,
  httpError,
  auditar,
  requireAuth,
  rateLimit,
  leerCookie,
  perfilUsuario,
  leerSeguridad,
} = require('../middleware');
const { cookieSecure } = require('../config');

const router = express.Router();

// Cookie de cierre: Secure según config/request.
function cookieCerrada(req) {
  let c = 'tc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
  if (cookieSecure(req)) c += '; Secure';
  return c;
}

// recordarme=false → cookie de sesión (sin Max-Age, muere al cerrar navegador).
// recordarme=true  → cookie persistente Max-Age = recordarme_horas*3600.
// segura: flag Secure resuelto por config COOKIE_SECURE (auto = request HTTPS).
function cookieSesion(token, recordarme, recordarmeHoras, segura) {
  let c = `tc_session=${token}; HttpOnly; SameSite=Lax; Path=/`;
  if (recordarme) c += `; Max-Age=${recordarmeHoras * 3600}`;
  if (segura) c += '; Secure';
  return c;
}

const BLOQUEOS_ESTADO = {
  'Pendiente aprobación': ['CUENTA_PENDIENTE', 'Tu cuenta está pendiente de aprobación por el administrador'],
  Rechazado: ['CUENTA_RECHAZADA', 'Tu solicitud de registro fue rechazada por la administración'],
  Suspendido: ['CUENTA_SUSPENDIDA', 'Tu cuenta está suspendida. Contacta a la administración'],
};

// Login: máx 5 intentos/min por IP+documento (contrato §5).
const limitadorLogin = rateLimit({
  ventanaMs: 60000,
  max: 5,
  clave: (req) => String((req.body && req.body.documento) || ''),
});

// H-5: además, techo global por IP para todo /login (evita rotar documentos).
const limitadorLoginIP = rateLimit({ ventanaMs: 60000, max: 20 });

// Autorregistro público: máx 5/hora por IP (contrato v2).
const limitadorRegistro = rateLimit({ ventanaMs: 3600000, max: 5 });

// Anti timing-oracle: si el documento no existe se verifica contra un hash dummy,
// de modo que el tiempo de respuesta sea comparable al de un usuario real.
let HASH_DUMMY = null;
function hashDummy() {
  if (!HASH_DUMMY) HASH_DUMMY = hashPassword('equalizador-tiempo-tuconjunto');
  return HASH_DUMMY;
}

router.post('/login', limitadorLoginIP, limitadorLogin, wrap(async (req, res) => {
  const v = validar(
    {
      documento: { tipo: 'string', requerido: true, max: 32 },
      password: { tipo: 'string', requerido: true, max: 128 },
      recordarme: { tipo: 'bool', requerido: false, defecto: false },
    },
    req.body
  );
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);

  const { documento, password, recordarme } = v.valores;
  const ip = req.socket.remoteAddress || null;
  const ahora = ahoraMs();

  // Parámetros dinámicos (leídos en cada intento, sin cache).
  const seg = leerSeguridad();
  const sesionMs = seg.sesion_minutos * 60000;
  const bloqueoMs = seg.bloqueo_minutos * 60000;

  const usuario = db.prepare('SELECT * FROM usuarios WHERE documento = ?').get(documento);

  if (usuario && usuario.locked_until && usuario.locked_until > ahora) {
    auditar(usuario.id, 'login_bloqueado', `Documento ${documento}`, ip);
    throw httpError(429, 'BLOQUEADA', 'Cuenta bloqueada temporalmente');
  }

  const claveValida = usuario
    ? verifyPassword(password, usuario.password_hash)
    : (void verifyPassword(password, hashDummy()), false);

  if (!usuario || !claveValida) {
    if (usuario) {
      const fallos = usuario.failed_attempts + 1;
      const lockedUntil = fallos >= seg.intentos_login ? ahora + bloqueoMs : usuario.locked_until;
      db.prepare('UPDATE usuarios SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(
        fallos,
        lockedUntil,
        usuario.id
      );
    }
    auditar(usuario ? usuario.id : null, 'login_fallo', `Documento ${documento}`, ip);
    throw httpError(401, 'CREDENCIALES', 'Documento o contraseña incorrectos');
  }

  const bloqueoEstado = BLOQUEOS_ESTADO[usuario.estado];
  if (bloqueoEstado) {
    auditar(usuario.id, 'login_bloqueo_estado', `Documento ${documento} estado=${usuario.estado}`, ip);
    throw httpError(403, bloqueoEstado[0], bloqueoEstado[1]);
  }

  // Éxito: resetear contadores de bloqueo.
  db.prepare('UPDATE usuarios SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(usuario.id);

  const duracionMs = recordarme ? seg.recordarme_horas * 3600000 : sesionMs;
  const expiraEn = ahora + duracionMs;

  const token = nuevoToken();
  db.prepare('INSERT INTO sesiones(token_hash,usuario_id,expira_en,creado_en) VALUES(?,?,?,?)').run(
    sha256(token),
    usuario.id,
    expiraEn,
    ahora
  );
  res.setHeader('Set-Cookie', cookieSesion(token, recordarme, seg.recordarme_horas, cookieSecure(req)));
  auditar(usuario.id, 'login_ok', recordarme ? 'recordarme=1' : '', ip);
  ok(res, { usuario: perfilUsuario(usuario), sesion: { expira_en_ms: expiraEn } });
}));

/* ------------------------ Registro público ------------------------- */

router.post('/registro', limitadorRegistro, wrap(async (req, res) => {
  const seg = leerSeguridad();
  const v = validar(
    {
      nombre: { tipo: 'string', requerido: true, max: 80 },
      tipo_doc: { tipo: 'enum', enum: ['CC', 'CE', 'PAS'], requerido: true },
      documento: { tipo: 'string', requerido: true, max: 20 },
      email: { tipo: 'email', requerido: true, max: 120 },
      celular: { tipo: 'string', requerido: true, max: 32 },
      password: { tipo: 'string', requerido: true, max: 128 },
      tipo: { tipo: 'enum', enum: ['copropietario', 'arrendatario'], requerido: true },
      torre: { tipo: 'string', requerido: true, max: 20 },
      apto: { tipo: 'string', requerido: true, max: 20 },
    },
    req.body
  );
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);
  const d = v.valores;

  if (d.documento.length < 5) throw httpError(400, 'VALIDACION', 'El documento debe tener al menos 5 caracteres');
  if (d.password.length < seg.password_min) {
    throw httpError(400, 'VALIDACION', `La contraseña debe tener al menos ${seg.password_min} caracteres`);
  }

  if (db.prepare('SELECT id FROM usuarios WHERE documento = ?').get(d.documento)) {
    throw httpError(409, 'YA_REGISTRADO', 'Ya existe una cuenta con ese documento');
  }
  if (db.prepare('SELECT id FROM usuarios WHERE email = ?').get(d.email)) {
    throw httpError(409, 'YA_REGISTRADO', 'Ya existe una cuenta con ese correo electrónico');
  }

  const ip = req.socket.remoteAddress || null;

  db.transaction(() => {
    // Unidad por torre+apto exactos; si no existe se crea (coeficiente NULL).
    let unidad = db.prepare('SELECT id FROM unidades WHERE torre = ? AND apto = ?').get(d.torre, d.apto);
    if (!unidad) {
      const infoU = db.prepare('INSERT INTO unidades(torre,apto,coeficiente) VALUES(?,?,NULL)').run(d.torre, d.apto);
      unidad = { id: Number(infoU.lastInsertRowid) };
    }

    const info = db
      .prepare(
        `INSERT INTO usuarios(nombre,tipo_doc,documento,email,celular,rol,estado,unidad_id,password_hash,debe_cambiar_clave,creado_en)
         VALUES(?,?,?,?,?,?,'Pendiente aprobación',?,?,0,?)`
      )
      .run(d.nombre, d.tipo_doc, d.documento, d.email, d.celular, d.tipo, unidad.id, hashPassword(d.password), ahoraMs());

    auditar(
      info.lastInsertRowid,
      'registro_publico',
      `documento=${d.documento} torre=${d.torre} apto=${d.apto} rol=${d.tipo}`,
      ip
    );
  })();

  ok(res, { mensaje: 'Registro recibido. Tu cuenta espera aprobación del administrador.', estado: 'Pendiente aprobación' }, 201);
}));

/* --------------------- Cambio de contraseña propio ------------------ */

router.post('/cambiar-clave', requireAuth, wrap(async (req, res) => {
  const v = validar(
    {
      actual: { tipo: 'string', requerido: true, max: 128 },
      nueva: { tipo: 'string', requerido: true, max: 128 },
    },
    req.body
  );
  if (!v.ok) throw httpError(400, 'VALIDACION', v.error);
  const { actual, nueva } = v.valores;

  const fila = db.prepare('SELECT password_hash FROM usuarios WHERE id = ?').get(req.usuarioIdInterno);
  if (!fila || !verifyPassword(actual, fila.password_hash)) {
    throw httpError(400, 'CLAVE_ACTUAL', 'La contraseña actual no es correcta');
  }
  const seg = leerSeguridad();
  if (nueva.length < seg.password_min) {
    throw httpError(400, 'VALIDACION', `La nueva contraseña debe tener al menos ${seg.password_min} caracteres`);
  }
  if (nueva === actual) {
    throw httpError(400, 'VALIDACION', 'La nueva contraseña debe ser diferente de la actual');
  }

  const token = leerCookie(req, 'tc_session');
  db.transaction(() => {
    db.prepare('UPDATE usuarios SET password_hash = ?, debe_cambiar_clave = 0 WHERE id = ?').run(
      hashPassword(nueva),
      req.usuarioIdInterno
    );
    // Revoca todas las OTRAS sesiones del usuario (conserva la actual).
    db.prepare('DELETE FROM sesiones WHERE usuario_id = ? AND token_hash != ?').run(
      req.usuarioIdInterno,
      sha256(token || '')
    );
    auditar(req.usuarioIdInterno, 'cambio_clave', '', req.socket.remoteAddress || null);
  })();

  ok(res, { mensaje: 'Contraseña actualizada. Se cerraron tus otras sesiones.' });
}));

router.post('/logout', wrap(async (req, res) => {
  const token = leerCookie(req, 'tc_session');
  if (token) db.prepare('DELETE FROM sesiones WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', cookieCerrada(req));
  ok(res, { mensaje: 'Sesión cerrada' });
}));

router.get('/me', requireAuth, (req, res) => {
  ok(res, { usuario: req.usuario });
});

module.exports = router;
