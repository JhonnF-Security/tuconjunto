# Changelog — TuConjunto

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

## [1.1.0] — 2026-08-26

### Añadido
- Integración de pagos PSE reales (Wompi): tabla `transacciones_pse`, endpoint de inicio con firma SHA256, webhook firmado idempotente, consulta de estado y expiración automática (30 min)
- Suite de pruebas E2E de pagos: `npm run test:pse` (20 aserciones)
- Comando `npm run create-admin` para el primer administrador en producción
- Guard en `seed.js`: se niega a correr si otro proceso tiene la BD abierta
- Documentación: `docs/CONTEXTO.md`, `docs/BITACORA.md`, `deploy/PSE-INTEGRACION.md`

### Seguridad
- Suspensión de usuario invalida sesiones activas al instante (CUENTA_INACTIVA)
- Contraseñas temporales aleatorias de 12 caracteres (antes = número de documento)
- Botón de pánico: rate-limit 3/5min por usuario + deduplicación de alertas activas
- Login sin oráculo de tiempo (hash dummy scrypt cuando el documento no existe)
- deploy.sh: TRUST_PROXY=1 forzado, HOST=127.0.0.1, firewall ufw 22/80/443
- systemd endurecido: 14 directivas adicionales

### Corregido
- nginx vhost inicial solo puerto 80 → despliegue TLS ya no falla en VPS limpio
- Esquema BD creado idempotentemente al arranque (instalación limpia funcional)
- Banner destructivo de deploy.sh eliminado
- Procedimiento seguro de restauración de backups documentado (WAL/SHM)

## [1.0.0] — 2026-08-24

### Añadido
- Plataforma completa: auth con 5 roles, residentes (PSE simulado, reservas, PQRS, pánico), portería (visitantes con foto, alertas en vivo), administración (KPIs, cartera, comunicados, documentos, asambleas con votación), landing comercial con wizard de suscripción
- Backend Node/Express + SQLite con seguridad OWASP (scrypt, sesiones hasheadas, RBAC, CSRF, rate-limiting, CSP+nonce, auditoría)
- Paquete de despliegue VPS (nginx + Certbot + systemd + backups diarios)
