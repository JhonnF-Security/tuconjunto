#!/bin/bash
# Deploy script para tuconjunto-prod usando Docker

set -e

echo "🐳 Building TuConjunto Docker image..."

# Build
docker compose build --no-cache

echo "✅ Build completado"

# Stop existing
docker compose down

echo "🚀 Starting containers..."
docker compose up -d

echo "⏳ Waiting for health check..."
sleep 10

# Verify
if curl -sf http://localhost:8081/api/health > /dev/null; then
    echo "✅ TuConjunto corriendo en http://localhost:8081"
    echo "📋 Logs: docker compose logs -f"
else
    echo "❌ Health check falló"
    docker compose logs app
    exit 1
fi
