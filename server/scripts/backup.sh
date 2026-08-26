#!/usr/bin/env bash
#
# Backup de la base SQLite de TuConjunto mediante VACUUM INTO (snapshot
# consistente aunque el servidor esté corriendo en WAL).
#
# Uso: ./scripts/backup.sh   (o: npm run backup, desde server/)
# Cron sugerido (diario 03:00):
#   0 3 * * * cd /ruta/a/tu-conjunto/server && ./scripts/backup.sh >> backups/backup.log 2>&1
#
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_FILE="${DB_FILE:-$RAIZ/data/tuconjunto.db}"
BACKUP_DIR="$RAIZ/backups"
RETENCION_DIAS="${BACKUP_RETENTION_DAYS:-30}"

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_FILE" ]; then
  echo "[backup] ERROR: no existe la base $DB_FILE" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
DESTINO="$BACKUP_DIR/tuconjunto-$STAMP.db"

if command -v sqlite3 >/dev/null 2>&1; then
  echo "[backup] sqlite3 CLI: VACUUM INTO $DESTINO"
  sqlite3 "$DB_FILE" "VACUUM INTO '$DESTINO';"
else
  echo "[backup] sqlite3 CLI no encontrado; usando better-sqlite3 de node"
  node -e '
    const Database = require("better-sqlite3");
    const [origen, destino] = process.argv.slice(1);
    const sqlLit = "'"'"'" + String(destino).replace(/'"'"'/g, "'"'"''"'"'") + "'"'"'";
    const db = new Database(origen, { readonly: true });
    db.exec(`VACUUM INTO ${sqlLit}`);
    db.close();
    console.log("[backup] ok");
  ' "$DB_FILE" "$DESTINO"
fi

if [ ! -s "$DESTINO" ]; then
  echo "[backup] ERROR: backup vacío o inexistente: $DESTINO" >&2
  exit 1
fi

echo "[backup] generado: $DESTINO ($(du -h "$DESTINO" | cut -f1))"

# Retención: borrar backups con más de RETENCION_DIAS días.
BORRADOS=$(find "$BACKUP_DIR" -name 'tuconjunto-*.db' -type f -mtime +"$RETENCION_DIAS" -print -delete | wc -l)
echo "[backup] retención ${RETENCION_DIAS}d: $BORRADOS backup(s) antiguos eliminados"
