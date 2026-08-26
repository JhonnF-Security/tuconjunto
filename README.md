# TuConjunto

Plataforma web de administración de conjuntos residenciales y copropiedades (Colombia · Ley 675 de 2001).

## Arquitectura

- **Backend**: Node.js + Express + SQLite (`better-sqlite3`) — `server/`
- **Base de datos local**: `server/data/tuconjunto.db` (WAL, foreign keys)
- **Frontend**: HTML5 + Tailwind compilado localmente, consumiendo la API REST con sesiones por cookie httpOnly
- **Seguridad** (auditada según OWASP): scrypt para contraseñas, sesiones con token 256-bit hasheado en BD, RBAC por rol, sentencias preparadas, validación estricta de entrada, CSRF por header, rate-limiting, magic-bytes en subidas, cabeceras CSP/nosniff/DENY, auditoría de acciones sensibles.

## Arranque

```bash
cd server
npm install          # dependencias
npm run seed         # crea/reinicia la BD con datos demo (¡BORRA la BD existente!)
npm start            # sirve app + API en http://localhost:8081
```

El esquema de la BD se crea automáticamente al arrancar (`CREATE IF NOT EXISTS`):
una instalación limpia sin seed funciona. Para producción crea el administrador real:

```bash
npm run create-admin -- --documento TU_DOCUMENTO --nombre "Tu Nombre"
```

Credenciales demo (todas `demo1234`, solo tras `npm run seed`):

| Rol            | Documento | Usuario           |
|----------------|-----------|-------------------|
| administrador  | 1020001   | Jorge Ramírez     |
| consejo        | 1020002   | Marta Ruiz        |
| porteria       | 1020003   | Carlos Vega       |
| copropietario  | 1020004   | Ana María Gómez   |
| arrendatario   | 1020005   | Pedro Salas       |

## Módulos operativos

- **Auth**: login real, sesión 8h, logout, bloqueo anti fuerza bruta
- **Residentes**: pago PSE simulado, reservas de zonas comunes, PQRS, botón de pánico
- **Portería**: registro de visitantes (foto rostro/cédula), entradas/salidas, recepción de alertas pánico en vivo
- **Administración**: KPIs en vivo, comunidad/usuarios/roles, aprobación de reservas, gestión PQRS, pagos y cartera, comunicados, documentos, asambleas con votación, logo del conjunto
- **Landing comercial**: catálogo, planes, wizard de suscripción (trial 14 días) que registra leads en la BD

## Estructura

```
tu-conjunto/
├── index.html, img/, styles.css...   # landing (fuente original estática)
├── demo/                             # prototipos históricos (localStorage)
└── server/
    ├── CONTRACT.md                   # contrato de API v1 (vinculante)
    ├── src/                          # backend (index.js, db.js, middleware.js, routes/)
    ├── public/                       # APP REAL servida por Express
    │   ├── assets/api.js             # cliente HTTP (TC.api)
    │   └── login/admin/residente/porteria .html
    └── data/tuconjunto.db            # base de datos SQLite local
```

Nota: `demo/` y la raíz contienen los prototipos originales; la aplicación funcional vive en `server/public/`.

## Despliegue e integración de pagos

- **VPS**: ver `deploy/DEPLOY.md` (script automático con nginx + TLS + systemd endurecido + firewall + backups).
- **Pagos PSE reales**: el simulador actual está listo para enlazarse con Wompi
  (recomendada) u otra pasarela. Plan por fases y variables de entorno en `deploy/PSE-INTEGRACION.md`.
