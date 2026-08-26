# TuConjunto — Contexto del proyecto

> Este documento es la fuente única de verdad sobre QUÉ es el proyecto, PARA QUIÉN y CÓMO está construido. Actualízalo cuando cambie algo estructural.

## 1. Qué es

Plataforma web de administración de conjuntos residenciales y copropiedades en Colombia (marco legal: Ley 675 de 2001). Permite a un conjunto gestionar residentes, pagos de administración, reservas, correspondencia/portería, PQRS, asambleas y comunicaciones — con una landing comercial para vender el servicio a otros conjuntos.

## 2. Usuarios y roles

| Rol | Qué hace |
|---|---|
| **administrador** | Todo: usuarios, unidades, cuotas/cartera, aprobaciones, documentos, asambleas, configuración |
| **consejo** | Supervisión: KPIs, cartera, comunicados, asambleas (sin editar usuarios) |
| **porteria** | Control de acceso: registro de visitantes con foto, entradas/salidas, alertas pánico en vivo |
| **copropietario** | Pagar administración (PSE), reservar zonas comunes, PQRS, botón de pánico |
| **arrendatario** | Igual que copropietario pero vinculado a la unidad que arrienda |

## 3. Arquitectura

```
Navegador ──HTTPS──▶ nginx (:80/:443, TLS) ──▶ Node/Express (:8081, solo local)
                                                │
                                                ▼
                                          SQLite (WAL) server/data/
```

- **Backend**: Node.js + Express + better-sqlite3 (`server/src/`)
  - `index.js` arranque/TLS/rutas · `db.js` esquema idempotente · `middleware.js` auth/RBAC/CSRF/CSP/rate-limit
  - `routes/`: 17 routers (auth, usuarios, pagos, reservas, pqrs, visitas, alertas, asambleas, etc.)
  - `CONTRACT.md` contrato de API v1/v2.1 (vinculante)
- **Frontend**: HTML5 + Tailwind compilado localmente, cliente HTTP centralizado (`server/public/assets/api.js` = TC.api), páginas por rol (login/admin/residente/porteria)
- **Pagos**: simulador interno para demos + integración real Wompi (PSE) lista para activar con llaves → ver `deploy/PSE-INTEGRACION.md`
- **Despliegue**: script automático `deploy/deploy.sh` (nginx + Certbot + systemd endurecido + ufw + backups diarios)

## 4. Seguridad (auditada contra OWASP)

- scrypt (N=16384) para contraseñas · tokens de sesión 256-bit hasheados SHA-256 en BD
- Sesiones httpOnly SameSite=Lax · bloqueo anti fuerza bruta configurable
- RBAC estricto por rol + verificación de ownership (anti-IDOR)
- Sentencias preparadas al 100% · validación estricta de entrada (rechaza campos extra)
- CSRF por cabecera X-Requested-With · rate-limiting por IP/usuario/cuenta
- Magic-bytes reales en subidas · CSP con nonce por request
- Auditoría de acciones sensibles en tabla `auditoria`

## 5. Estado actual (2026-08-26)

- ✅ Todos los módulos por rol funcionales (validados con pruebas E2E manuales + curl)
- ✅ 4 fixes de seguridad aplicados y verificados (suspensión→sesión, claves temporales aleatorias, anti-spam pánico, timing oracle)
- ✅ Paquete de despliegue VPS completo sin bloqueantes
- ✅ Pagos Wompi F1–F4 implementados (20 aserciones E2E: `npm run test:pse`)
- ⏳ Pendiente: contratar cuenta Wompi real (llaves), desplegar a VPS con dominio

## 6. Dónde está cada cosa

```
tu-conjunto/
├── index.html, img/          # landing comercial (estática)
├── demo/                     # prototipos históricos (localStorage, solo referencia)
├── docs/                     # ESTA carpeta: contexto, bitácora diaria
├── deploy/                   # DEPLOY.md, deploy.sh, nginx, systemd, PSE-INTEGRACION.md
└── server/
    ├── CONTRACT.md           # contrato de API
    ├── src/                  # backend
    ├── public/               # app real servida por Express (+ guia-pruebas.html)
    ├── scripts/              # backup.sh, create-admin.js, prueba-e2e-pse.mjs
    └── data/                 # BD local (NO se sube a git)
```

## 7. Comandos de uso diario

```bash
cd server
npm start              # arrancar (http://localhost:8081)
npm run seed           # regenerar BD demo (DETÉN el servidor primero; el guard te avisa)
npm run create-admin   # crear administrador real
npm run test:pse       # 20 pruebas E2E de pagos
npm run backup         # backup manual de la BD
```

Usuarios demo (clave `demo1234`): admin 1020001 · consejo 1020002 · portería 1020003 · copropietario 1020004 · arrendatario 1020005
