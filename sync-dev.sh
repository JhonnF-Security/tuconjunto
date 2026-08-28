#!/bin/bash
# sync-dev.sh - Actualiza repo local, instala deps, seed BD y arranca servidor
# Uso: ./sync-dev.sh [--no-seed] [--docker]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$REPO_ROOT/server"
DO_SEED=true
USE_DOCKER=false

for arg in "$@"; do
  case $arg in
    --no-seed) DO_SEED=false ;;
    --docker) USE_DOCKER=true ;;
    *) echo "Uso: $0 [--no-seed] [--docker]"; exit 1 ;;
  esac
done

cd "$REPO_ROOT"

echo "📥 Pulling latest changes..."
git pull origin main

if [[ "$USE_DOCKER" == true ]]; then
  echo "🐳 Docker mode: building and starting..."
  docker compose build --no-cache
  docker compose up -d
  echo "✅ Corriendo en http://localhost:8081"
  echo "📋 Logs: docker compose logs -f"
  exit 0
fi

cd "$SERVER_DIR"

echo "📦 Installing dependencies..."
npm ci

if [[ "$DO_SEED" == true ]]; then
  echo "🌱 Seeding database (THIS DELETES EXISTING DATA)..."
  npm run seed
else
  echo "⏭️  Skipping seed (use --no-seed to skip)"
fi

echo "🚀 Starting server..."
npm start
