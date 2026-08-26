'use strict';

const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, KEYLEN, SCRYPT).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(pw, stored) {
  try {
    const partes = String(stored).split('$');
    if (partes.length !== 3 || partes[0] !== 'scrypt') return false;
    const [, salt, hash] = partes;
    const calculado = crypto.scryptSync(String(pw), salt, KEYLEN, SCRYPT);
    const esperado = Buffer.from(hash, 'hex');
    if (calculado.length !== esperado.length) return false;
    return crypto.timingSafeEqual(calculado, esperado);
  } catch {
    return false;
  }
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function nuevoToken() {
  return crypto.randomBytes(32).toString('hex');
}

function ahoraMs() {
  return Date.now();
}

function formatCOP(n) {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(Number(n) || 0);
}

/* ------------------------------------------------------------------ */
/* Validador estricto                                                  */
/* ------------------------------------------------------------------ */

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function fallo(mensaje) {
  return { ok: false, error: mensaje };
}

function validar(schema, objeto) {
  if (objeto === null || objeto === undefined || typeof objeto !== 'object' || Array.isArray(objeto)) {
    return fallo('Cuerpo de la petición inválido');
  }
  const valores = {};
  for (const campo of Object.keys(objeto)) {
    if (!Object.prototype.hasOwnProperty.call(schema, campo)) {
      return fallo(`Campo no permitido: ${campo}`);
    }
  }
  for (const [campo, regla] of Object.entries(schema)) {
    const requerido = regla.requerido !== false;
    let v = objeto[campo];
    const ausente = v === undefined || v === null || v === '';
    if (ausente) {
      if (requerido) return fallo(`Campo requerido faltante: ${campo}`);
      if (Object.prototype.hasOwnProperty.call(regla, 'defecto')) valores[campo] = regla.defecto;
      continue;
    }
    switch (regla.tipo) {
      case 'string':
      case 'enum': {
        if (typeof v !== 'string') return fallo(`${campo} debe ser texto`);
        v = v.trim();
        const max = regla.max || 255;
        if (v.length > max) return fallo(`${campo} excede la longitud máxima (${max})`);
        if (regla.enum) {
          if (!regla.enum.includes(v)) return fallo(`${campo} debe ser uno de: ${regla.enum.join(', ')}`);
        }
        if (requerido && v === '') return fallo(`${campo} no puede estar vacío`);
        valores[campo] = v;
        break;
      }
      case 'int': {
        if (typeof v !== 'number' || !Number.isInteger(v) || !Number.isFinite(v)) {
          return fallo(`${campo} debe ser un número entero`);
        }
        if (regla.min !== undefined && v < regla.min) return fallo(`${campo} debe ser ≥ ${regla.min}`);
        if (regla.max !== undefined && v > regla.max) return fallo(`${campo} debe ser ≤ ${regla.max}`);
        valores[campo] = v;
        break;
      }
      case 'numero': {
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          return fallo(`${campo} debe ser un número`);
        }
        if (regla.min !== undefined && v < regla.min) return fallo(`${campo} debe ser ≥ ${regla.min}`);
        if (regla.max !== undefined && v > regla.max) return fallo(`${campo} debe ser ≤ ${regla.max}`);
        valores[campo] = v;
        break;
      }
      case 'bool': {
        if (typeof v !== 'boolean') return fallo(`${campo} debe ser booleano`);
        valores[campo] = v;
        break;
      }
      case 'fecha': {
        if (typeof v !== 'string' || !RE_FECHA.test(v)) return fallo(`${campo} debe tener formato YYYY-MM-DD`);
        const d = new Date(`${v}T00:00:00Z`);
        if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
          return fallo(`${campo} no es una fecha válida`);
        }
        valores[campo] = v;
        break;
      }
      case 'mes': {
        if (typeof v !== 'string' || !RE_MES.test(v)) return fallo(`${campo} debe tener formato YYYY-MM`);
        valores[campo] = v;
        break;
      }
      case 'email': {
        if (typeof v !== 'string') return fallo(`${campo} debe ser texto`);
        v = v.trim().toLowerCase();
        if (v.length > (regla.max || 120)) return fallo(`${campo} excede la longitud máxima`);
        if (!RE_EMAIL.test(v)) return fallo(`${campo} no es un correo válido`);
        valores[campo] = v;
        break;
      }
      case 'lista': {
        if (!Array.isArray(v)) return fallo(`${campo} debe ser una lista`);
        if (regla.minItems !== undefined && v.length < regla.minItems) return fallo(`${campo} requiere al menos ${regla.minItems} elementos`);
        if (regla.maxItems !== undefined && v.length > regla.maxItems) return fallo(`${campo} admite máximo ${regla.maxItems} elementos`);
        const items = [];
        for (const it of v) {
          if (typeof it !== 'string') return fallo(`${campo} solo admite textos`);
          const t = it.trim();
          if (!t) return fallo(`${campo} contiene elementos vacíos`);
          if (t.length > (regla.itemMax || 120)) return fallo(`${campo} tiene elementos demasiado largos`);
          items.push(t);
        }
        valores[campo] = items;
        break;
      }
      default:
        return fallo(`Regla de validación desconocida para ${campo}`);
    }
  }
  return { ok: true, valores };
}

/* ------------------------------------------------------------------ */
/* dataURL (fotos / documentos)                                        */
/* ------------------------------------------------------------------ */

const MAGICS = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/gif': (b) => b.slice(0, 3).toString('latin1') === 'GIF',
  'image/webp': (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP',
  'application/pdf': (b) => b.slice(0, 5).toString('latin1') === '%PDF-',
};

// Devuelve {mime,buffer} o null si el dataURL es inválido.
function leerDataUrl(v) {
  if (typeof v !== 'string') return null;
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(v);
  if (!m) return null;
  let buffer;
  try {
    buffer = Buffer.from(m[2], 'base64');
  } catch {
    return null;
  }
  // Validación estricta: re-codificar debe reproducir el input (sin basura).
  if (buffer.length === 0) return null;
  return { mime: m[1].toLowerCase(), buffer };
}

function magicOk(mime, buffer) {
  const chk = MAGICS[mime];
  return typeof chk === 'function' && chk(buffer);
}

module.exports = {
  hashPassword,
  verifyPassword,
  sha256,
  nuevoToken,
  ahoraMs,
  formatCOP,
  validar,
  leerDataUrl,
  magicOk,
};
