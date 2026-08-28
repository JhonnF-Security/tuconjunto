'use strict';

// Archivos creados por el servidor (BD, WAL, backups) solo legibles por su dueño.
try { process.umask(0o077); } catch { /* umask no modificable en algunos entornos */ }

const fs = require('fs');
const path = require('path');
const express = require('express');

const config = require('./config');
const { db, crearEsquema } = require('./db');

// Esquema idempotente (CREATE IF NOT EXISTS): garantiza que una instalación
// limpia (sin seed) arranque con tablas y pueda crear su primer administrador.
crearEsquema(db);
const {
  seguridadHeaders,
  noncePorRequest,
  inyectarNonceHtml,
  csrfMutaciones,
  errorHandler,
  rateLimit,
  wrap,
  httpError,
} = require('./middleware');

const app = express();
app.disable('x-powered-by');

// Detrás de proxy TLS (nginx/traefik/caddy): req.secure/req.ip según TRUST_PROXY.
app.set('trust proxy', config.TRUST_PROXY);

// Nonce CSP por request ANTES de cualquier respuesta.
app.use(noncePorRequest);

// Cabeceras de seguridad en TODAS las respuestas (contrato §3).
app.use(seguridadHeaders);

/* ------------------------- Health público ------------------------------ */
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'up', uptime_s: Math.floor(process.uptime()), version: VERSION });
});

/* ------------------- HTML con inyección de nonce CSP -------------------- */
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function enviarHtml(res, rel) {
  const rutaAbsoluta = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!rutaAbsoluta.startsWith(PUBLIC_DIR + path.sep) && rutaAbsoluta !== PUBLIC_DIR) {
    throw httpError(404, 'NO_ENCONTRADO', 'Ruta no encontrada');
  }
  let contenido;
  try {
    contenido = fs.readFileSync(rutaAbsoluta, 'utf8');
  } catch {
    throw httpError(404, 'NO_ENCONTRADO', 'Ruta no encontrada');
  }
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(inyectarNonceHtml(contenido, res.locals.nonce));
}

// Redirección limpia de rutas de página sin extensión → .html
const PAGINAS = ['index.html', 'login.html', 'residente.html', 'admin.html', 'porteria.html'];
for (const pagina of PAGINAS) {
  const ruta = pagina === 'index.html' ? '/' : `/${pagina.replace(/\.html$/, '')}`;
  app.get(ruta, wrap((req, res) => enviarHtml(res, pagina)));
}
const existePagina = (base) =>
  PAGINAS.includes(base) ||
  (/^[\w-]+\.html$/.test(base) && fs.existsSync(path.join(__dirname, '..', 'public', base)));
app.get('/*.html', wrap((req, res, next) => {
  if (req.path.startsWith('/demo/')) return next(); // prototipos: los sirve el estático de /demo
  const base = path.basename(req.path); // solo nombre dentro de public/
  if (!existePagina(base)) return void res.status(404).send('Not found');
  enviarHtml(res, base);
}));

/* ----------------------------- Seguridad ------------------------------- */

// Body limits JSON: 1MB general; /api/documentos permite dataURLs hasta ~2MB;
// /api/visitas usa 900KB (fotos ≤300KB c/u ya como dataURL dentro del body).
app.use('/api/documentos', express.json({ limit: '2600kb' }));
app.use(express.json({ limit: '900kb' }));

// CSRF: todas las mutaciones exigen X-Requested-With: fetch.
app.use(csrfMutaciones);

// Rate-limit general de escrituras: 60/min por IP.
const limitadorEscrituras = rateLimit({ ventanaMs: 60000, max: 60 });
app.use('/api', (req, res, next) => (req.method === 'GET' ? next() : limitadorEscrituras(req, res, next)));

/* ----------------------------- Routers API ----------------------------- */
app.use('/api/auth', require('./routes/auth'));
app.use('/api/usuarios', require('./routes/usuarios'));
app.use('/api/zonas', require('./routes/zonas'));
app.use('/api/reservas', require('./routes/reservas'));
app.use('/api/pqrs', require('./routes/pqrs'));
app.use('/api/cartera', require('./routes/cartera'));
app.use('/api/visitas', require('./routes/visitas'));
app.use('/api/alertas', require('./routes/alertas'));
app.use('/api/comunicados', require('./routes/comunicados'));
app.use('/api/documentos', require('./routes/documentos'));
app.use('/api/asambleas', require('./routes/asambleas'));
app.use('/api/config', require('./routes/config'));
app.use('/api/unidades', require('./routes/unidades'));
app.use('/api/comunidad', require('./routes/comunidad'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/kpis', require('./routes/kpis'));

// Fallback JSON para cualquier ruta /api no definida.
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: { code: 'NO_ENCONTRADO', message: 'Ruta no encontrada' } });
});

/* ------------------------------ Estáticos ------------------------------ */
// Assets (css/js/img): sin index ni HTML (el HTML ya se sirve arriba con nonce).
app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    dotfiles: 'ignore',
  })
);
// Prototipos históricos (localStorage) bajo /demo — solo lectura de estáticos.
const DEMO_DIR = path.resolve(__dirname, '..', '..', 'demo');
if (fs.existsSync(DEMO_DIR)) {
  app.use('/demo', express.static(DEMO_DIR, { index: false, dotfiles: 'ignore' }));
}
app.use((req, res) => res.status(404).send('Not found'));

// Error handler central SIEMPRE al final.
app.use(errorHandler);

/* --------------------------- Arranque / TLS ---------------------------- */
let servidor;
if (config.TLS_ENABLED) {
  const opcionesTls = {
    key: fs.readFileSync(config.TLS_KEY_PATH),
    cert: fs.readFileSync(config.TLS_CERT_PATH),
  };
  servidor = require('https').createServer(opcionesTls, app);
} else {
  servidor = require('http').createServer(app);
}

// Barrido global de sesiones expiradas cada 10 min (regla de seguridad §10).
setInterval(() => {
  try {
    db.prepare('DELETE FROM sesiones WHERE expira_en <= ?').run(Date.now());
  } catch { /* DB cerrándose */ }
}, 10 * 60 * 1000).unref();

servidor.listen(config.PORT, config.HOST, () => {
  const esquema = config.TLS_ENABLED ? 'https' : 'http';
  console.log(`[start] TuConjunto API escuchando en ${esquema}://${config.HOST}:${config.PORT} (modo ${esquema})`);
});

/* -------------------------- Graceful shutdown -------------------------- */
let cerrando = false;
function apagar(seg) {
  if (cerrando) return;
  cerrando = true;
  console.log(`[shutdown] señal ${seg}: cerrando servidor...`);
  servidor.close(() => {
    try {
      db.close();
      console.log('[shutdown] DB cerrada');
    } catch (e) {
      console.error('[shutdown] error al cerrar DB:', e.message);
    }
    process.exit(0);
  });
  // Fuerza la salida si alguna conexión cuelga.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));

module.exports = { app, servidor };
