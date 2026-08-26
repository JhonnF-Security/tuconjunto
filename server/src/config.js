'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ */
/* Carga de .env (sin dependencias)                                    */
/* ------------------------------------------------------------------ */
// Lee server/.env si existe. NO sobreescribe variables ya presentes en
// el entorno (las env reales tienen prioridad sobre el archivo).

const RAIZ = path.join(__dirname, '..');

function cargarDotEnv(ruta) {
  let texto;
  try {
    texto = fs.readFileSync(ruta, 'utf8');
  } catch {
    return;
  }
  for (const linea of texto.split(/\r?\n/)) {
    const limpio = linea.trim();
    if (!limpio || limpio.startsWith('#')) continue;
    const i = limpio.indexOf('=');
    if (i === -1) continue;
    const clave = limpio.slice(0, i).trim();
    let valor = limpio.slice(i + 1).trim();
    // Quita comillas envolventes simples o dobles.
    if (
      (valor.startsWith('"') && valor.endsWith('"') && valor.length >= 2) ||
      (valor.startsWith("'") && valor.endsWith("'") && valor.length >= 2)
    ) {
      valor = valor.slice(1, -1);
    }
    if (!clave) continue;
    if (process.env[clave] === undefined || process.env[clave] === '') {
      process.env[clave] = valor;
    }
  }
}

cargarDotEnv(path.join(RAIZ, '.env'));

/* ------------------------------------------------------------------ */
/* Config efectiva                                                     */
/* ------------------------------------------------------------------ */

function rutaRelativaRaiz(v) {
  if (!v) return null;
  return path.isAbsolute(v) ? v : path.join(RAIZ, v);
}

const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 8081;

let HOST = process.env.HOST;
if (HOST === undefined || HOST === '') HOST = '0.0.0.0';

const TLS_KEY = process.env.TLS_KEY || '';
const TLS_CERT = process.env.TLS_CERT || '';

// COOKIE_SECURE: 'auto' (default) → Secure solo si la request es HTTPS;
// 'true' → siempre Secure; 'false' → nunca.
let COOKIE_SECURE = String(process.env.COOKIE_SECURE || 'auto').toLowerCase();
if (!['auto', 'true', 'false'].includes(COOKIE_SECURE)) COOKIE_SECURE = 'auto';
const cookieSecureSiempre = COOKIE_SECURE === 'true';
const cookieSecureNunca = COOKIE_SECURE === 'false';

// TRUST_PROXY: número de saltos de proxy de confianza para req.secure/req.ip.
let TRUST_PROXY = 0;
{
  const n = Number(process.env.TRUST_PROXY);
  if (Number.isInteger(n) && n >= 0 && String(process.env.TRUST_PROXY).trim() !== '') TRUST_PROXY = n;
}

const DB_FILE = rutaRelativaRaiz(process.env.DB_FILE) || path.join(RAIZ, 'data', 'tuconjunto.db');

// El servidor es HTTPS solo si AMBOS archivos TLS existen.
const tlsKeyPath = TLS_KEY ? rutaRelativaRaiz(TLS_KEY) : null;
const tlsCertPath = TLS_CERT ? rutaRelativaRaiz(TLS_CERT) : null;
const TLS_ENABLED = Boolean(
  tlsKeyPath &&
    tlsCertPath &&
    fs.existsSync(tlsKeyPath) &&
    fs.existsSync(tlsCertPath)
);

// Decide el flag Secure de la cookie según config y la request.
function cookieSecure(req) {
  if (cookieSecureSiempre) return true;
  if (cookieSecureNunca) return false;
  return Boolean(req && req.secure);
}

// ---------------------------------------------------------------------
// Pasarela de pagos (Wompi). Con PAYMENTS_PROVIDER=none funciona el
// simulador interno; con 'wompi' + llaves se activa el flujo real F2/F3.
// ---------------------------------------------------------------------

const PAYMENTS_PROVIDER = String(process.env.PAYMENTS_PROVIDER || 'none')
  .trim()
  .toLowerCase();
const WOMPI_ENV = process.env.WOMPI_ENV === 'production' ? 'production' : 'sandbox';
const WOMPI_PUBLIC_KEY = String(process.env.WOMPI_PUBLIC_KEY || '').trim();
const WOMPI_PRIVATE_KEY = String(process.env.WOMPI_PRIVATE_KEY || '').trim();
const WOMPI_INTEGRITY_SECRET = String(process.env.WOMPI_INTEGRITY_SECRET || '').trim();
const WOMPI_EVENTS_SECRET = String(process.env.WOMPI_EVENTS_SECRET || '').trim();
const APP_PUBLIC_BASE_URL = String(process.env.APP_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');

let PAGOS_TIMEOUT_MINUTOS = 30;
{
  const n = Number(process.env.PAGOS_TIMEOUT_MINUTOS);
  if (Number.isInteger(n) && n > 0 && n <= 720) PAGOS_TIMEOUT_MINUTOS = n;
}

// URLs oficiales según ambiente.
const WOMPI_API_BASE =
  WOMPI_ENV === 'production' ? 'https://production.wompi.co' : 'https://sandbox.wompi.co';
const WOMPI_CHECKOUT_BASE = 'https://checkout.wompi.co/p/';

// La pasarela real solo está activa con proveedor wompi Y llaves mínimas.
const PAGOS_WOMPI_ACTIVO =
  PAYMENTS_PROVIDER === 'wompi' &&
  Boolean(WOMPI_PUBLIC_KEY && WOMPI_INTEGRITY_SECRET);

module.exports = {
  PORT,
  HOST,
  TLS_KEY,
  TLS_CERT,
  TLS_KEY_PATH: tlsKeyPath,
  TLS_CERT_PATH: tlsCertPath,
  TLS_ENABLED,
  COOKIE_SECURE,
  TRUST_PROXY,
  DB_FILE,
  cookieSecure,
  RAIZ,
  // Pagos
  PAYMENTS_PROVIDER,
  WOMPI_ENV,
  WOMPI_PUBLIC_KEY,
  WOMPI_PRIVATE_KEY,
  WOMPI_INTEGRITY_SECRET,
  WOMPI_EVENTS_SECRET,
  APP_PUBLIC_BASE_URL,
  PAGOS_TIMEOUT_MINUTOS,
  WOMPI_API_BASE,
  WOMPI_CHECKOUT_BASE,
  PAGOS_WOMPI_ACTIVO,
};
