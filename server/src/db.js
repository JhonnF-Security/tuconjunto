'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { DB_FILE } = require('./config');

const DB_PATH = DB_FILE;
const DATA_DIR = path.dirname(DB_PATH);

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function crearEsquema(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre            TEXT NOT NULL,
      tipo_doc          TEXT NOT NULL DEFAULT 'CC',
      documento         TEXT NOT NULL UNIQUE,
      email             TEXT,
      celular           TEXT,
      rol               TEXT NOT NULL CHECK (rol IN ('administrador','consejo','porteria','copropietario','arrendatario')),
      estado            TEXT NOT NULL DEFAULT 'Activo' CHECK (estado IN ('Activo','Suspendido','Pendiente aprobación','Rechazado')),
      unidad_id         INTEGER REFERENCES unidades(id) ON DELETE SET NULL,
      password_hash     TEXT NOT NULL,
      debe_cambiar_clave INTEGER NOT NULL DEFAULT 0,
      failed_attempts   INTEGER NOT NULL DEFAULT 0,
      locked_until      INTEGER,
      creado_en         INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sesiones (
      token_hash  TEXT PRIMARY KEY,
      usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      expira_en   INTEGER NOT NULL,
      creado_en   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sesiones_usuario ON sesiones(usuario_id);
    CREATE INDEX IF NOT EXISTS idx_sesiones_expira ON sesiones(expira_en);

    CREATE TABLE IF NOT EXISTS unidades (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      torre           TEXT NOT NULL,
      apto            TEXT NOT NULL,
      coeficiente     REAL,
      propietario_id  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      UNIQUE(torre, apto)
    );

    CREATE TABLE IF NOT EXISTS zonas (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre      TEXT NOT NULL UNIQUE,
      capacidad   INTEGER NOT NULL,
      costo_hora  INTEGER NOT NULL,
      activa      INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS reservas (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      zona_id      INTEGER NOT NULL REFERENCES zonas(id),
      usuario_id   INTEGER NOT NULL REFERENCES usuarios(id),
      fecha        TEXT NOT NULL,
      franja       TEXT NOT NULL CHECK (franja IN ('manana','tarde','noche')),
      notas        TEXT,
      estado       TEXT NOT NULL DEFAULT 'Pendiente' CHECK (estado IN ('Pendiente','Confirmada','Rechazada','Cancelada')),
      revisada_por INTEGER,
      creado_en    INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reservas_slot
      ON reservas(zona_id, fecha, franja) WHERE estado != 'Rechazada';
    CREATE INDEX IF NOT EXISTS idx_reservas_usuario ON reservas(usuario_id);

    CREATE TABLE IF NOT EXISTS pqrs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo      TEXT NOT NULL UNIQUE,
      usuario_id  INTEGER NOT NULL REFERENCES usuarios(id),
      titulo      TEXT NOT NULL,
      descripcion TEXT NOT NULL,
      tipo        TEXT NOT NULL CHECK (tipo IN ('Convivencia','Mantenimiento','Administrativo','Otro')),
      prioridad   TEXT NOT NULL CHECK (prioridad IN ('Baja','Media','Alta')),
      estado      TEXT NOT NULL DEFAULT 'Abierto' CHECK (estado IN ('Abierto','En revisión','Resuelto')),
      asignado_a  INTEGER,
      creada_en   INTEGER NOT NULL,
      resuelta_en INTEGER
    );

    CREATE TABLE IF NOT EXISTS pagos (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      unidad_id       INTEGER NOT NULL REFERENCES unidades(id),
      concepto        TEXT NOT NULL,
      periodo         TEXT NOT NULL,
      valor           INTEGER NOT NULL,
      estado          TEXT NOT NULL DEFAULT 'Pendiente' CHECK (estado IN ('Pendiente','Pagado')),
      metodo          TEXT NOT NULL DEFAULT 'Manual',
      referencia      TEXT,
      fecha_pago      INTEGER,
      registrado_por  INTEGER,
      UNIQUE(unidad_id, periodo)
    );
    CREATE INDEX IF NOT EXISTS idx_pagos_estado ON pagos(estado, periodo);

    CREATE TABLE IF NOT EXISTS visitas (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre         TEXT NOT NULL,
      documento      TEXT NOT NULL,
      tipo           TEXT NOT NULL,
      unidad_destino TEXT NOT NULL,
      motivo         TEXT,
      foto_rostro    TEXT,
      foto_cedula    TEXT,
      entrada        INTEGER NOT NULL,
      salida         INTEGER,
      registrada_por INTEGER
    );

    CREATE TABLE IF NOT EXISTS alertas (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      unidad      TEXT,
      tipo        TEXT NOT NULL DEFAULT 'panico',
      atendida    INTEGER NOT NULL DEFAULT 0,
      creada_en   INTEGER NOT NULL,
      atendida_por INTEGER,
      atendida_en INTEGER
    );

    CREATE TABLE IF NOT EXISTS comunicados (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      titulo     TEXT NOT NULL,
      cuerpo     TEXT NOT NULL,
      categoria  TEXT NOT NULL,
      autor_id   INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      creado_en  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documentos (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre     TEXT NOT NULL,
      tamano     INTEGER NOT NULL,
      mime       TEXT NOT NULL,
      contenido  TEXT NOT NULL,
      subido_por INTEGER,
      creado_en  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS asambleas (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      titulo     TEXT NOT NULL,
      fecha      TEXT NOT NULL,
      lugar      TEXT NOT NULL,
      opciones   TEXT NOT NULL,
      estado     TEXT NOT NULL DEFAULT 'Convocada' CHECK (estado IN ('Convocada','Cerrada')),
      creada_por INTEGER,
      creado_en  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS asamblea_asistencia (
      asamblea_id INTEGER NOT NULL REFERENCES asambleas(id) ON DELETE CASCADE,
      usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      creado_en   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (asamblea_id, usuario_id)
    );

    CREATE TABLE IF NOT EXISTS asamblea_votos (
      asamblea_id INTEGER NOT NULL REFERENCES asambleas(id) ON DELETE CASCADE,
      usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      opcion      TEXT NOT NULL,
      creado_en   INTEGER NOT NULL,
      PRIMARY KEY (asamblea_id, usuario_id)
    );

    CREATE TABLE IF NOT EXISTS leads (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conjunto        TEXT NOT NULL,
      ciudad          TEXT NOT NULL,
      unidades        INTEGER NOT NULL,
      email           TEXT NOT NULL,
      celular         TEXT NOT NULL,
      plan            TEXT NOT NULL,
      contacto_nombre TEXT NOT NULL,
      creado_en       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config (
      clave TEXT PRIMARY KEY,
      valor TEXT
    );

    CREATE TABLE IF NOT EXISTS auditoria (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER,
      accion     TEXT NOT NULL,
      detalle    TEXT,
      ip         TEXT,
      creado_en  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auditoria_usuario ON auditoria(usuario_id, creado_en);
  `);
}

module.exports = { db, crearEsquema, DB_PATH };
