@echo off
REM sync-dev.bat - Actualiza repo local, instala deps, seed BD y arranca servidor (Windows)
REM Uso: sync-dev.bat [--no-seed] [--docker]

set REPO_ROOT=%~dp0
set SERVER_DIR=%REPO_ROOT%server
set DO_SEED=true
set USE_DOCKER=false

for %%a in (%*) do (
  if "%%a"=="--no-seed" set DO_SEED=false
  if "%%a"=="--docker" set USE_DOCKER=true
)

cd /d "%REPO_ROOT%"

echo 📥 Pulling latest changes...
git pull origin main

if "%USE_DOCKER%"=="true" (
  echo 🐳 Docker mode: building and starting...
  docker compose build --no-cache
  docker compose up -d
  echo ✅ Corriendo en http://localhost:8081
  echo 📋 Logs: docker compose logs -f
  exit /b 0
)

cd /d "%SERVER_DIR%"

echo 📦 Installing dependencies...
npm ci

if "%DO_SEED%"=="true" (
  echo 🌱 Seeding database (THIS DELETES EXISTING DATA)...
  npm run seed
) else (
  echo ⏭️  Skipping seed (use --no-seed to skip)
)

echo 🚀 Starting server...
npm start
