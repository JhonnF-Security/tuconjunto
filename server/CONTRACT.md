# TuConjunto — Contrato de API y Seguridad (v1 CONGELADO)

Backend: Node.js 20 + Express + better-sqlite3 (archivo `server/data/tuconjunto.db`).
Frontend: los HTML de `server/public/` llaman a la API con `fetch(credenciales same-origin)`.
Formato de respuesta uniforme: éxito `{"ok":true,"data":...}` · error `{"ok":false,"error":{"code":"...","message":"..."}}`.
Errores HTTP: 400 validación, 401 no autenticado, 403 rol insuficiente, 404, 409 conflicto, 429 rate-limit.

## Autenticación y sesiones
- `POST /api/auth/login` {documento, password} → 200 {usuario:{id,nombre,rol,unidad}} + cookie `tc_session` (token 32B aleatorio; en BD solo sha256 del token; httpOnly; SameSite=Lax; Path=/; Max-Age 8h). Rate-limit: máx 5 intentos/min por IP+documento; cuenta se bloquea 15 min tras 5 fallos (usuarios.failed_attempts/locked_until).
- `POST /api/auth/logout` → borra sesión. `GET /api/auth/me` → usuario actual o 401.
- Hash: scrypt(N=16384,r=8,p=1) salt 16B aleatoria, formato `scrypt$salt$hash`, comparación timingSafeEqual.
- ROLES: `administrador`, `consejo` (lectura global), `porteria`, `copropietario`, `arrendatario`. Middleware `requireRole('a','b')`.

## Entidades y rutas (todas /api, JSON)
- **usuarios**: GET `/usuarios` (admin,consejo) · POST `/usuarios` (admin) {nombre,tipo_doc,documento,email?,celular?,rol,unidad_id?} crea con password temporal aleatoria (12 caracteres, se devuelve una sola vez en la respuesta) + debe cambiarla · PATCH `/usuarios/:id` (admin) {rol?,estado?,unidad_id?} · POST `/usuarios/:id/reset-password` (admin) → password temporal nueva.
- **unidades/zonas**: GET `/zonas` (auth) lista zonas comunes {id,nombre,capacidad,costo_hora,activa}.
- **reservas**: GET `/reservas?mias=1` (mias→propias cualquier residente; sin mias admin/consejo) · POST `/reservas` (copropietario,arrendatario) {zona_id,fecha:"YYYY-MM-DD",franja:"manana"|"tarde"|"noche",notas?} → estado "Pendiente"; rechazo si zona inactiva o ya existe reserva Confirmada misma zona+fecha+franja (409) · PATCH `/reservas/:id` (admin) {accion:"aprobar"|"rechazar"} · PATCH `/reservas/:id/cancelar` (dueño, solo Pendiente).
- **pqrs**: GET `/pqrs` (admin/consejo todas; residente propias) · POST `/pqrs` (residentes) {titulo,descripcion,tipo:"Convivencia"|"Mantenimiento"|"Administrativo"|"Otro",prioridad:"Baja"|"Media"|"Alta"} → codigo "T-"+secuencial · PATCH `/pqrs/:id` (admin) {accion:"atender"|"resolver"}.
- **pagos**: GET `/pagos` (admin/consejo todos; residente propios) · POST `/pagos/pse` (residentes) {periodo:"2026-08"} valida que exista cuota pendiente de su unidad → marca Pagado, metodo PSE, referencia "PG-"+5 dígitos, fecha ahora. Cuotas generadas por seed para julio(Pagado)/agosto(Pendiente).
- **cartera**: GET `/cartera` (admin,consejo) → [{unidad,total_pendiente,meses_mora}].
- **visitas**: GET `/visitas?q=` (porteria,admin; q busca nombre/doc/unidad) · POST `/visitas` (porteria) {nombre,documento,tipo,unidad_destino,motivo?,foto_rostro?,foto_cedula?} fotos=dataURL base64 ≤300KB validadas magic-bytes JPEG/PNG · PATCH `/visitas/:id/salida` (porteria).
- **alertas**: GET `/alertas?activas=1` (porteria,admin) · POST `/alertas` (auth) {} usa unidad del usuario · PATCH `/alertas/:id/atender` (porteria,admin).
- **comunicados**: GET `/comunicados` (auth) · POST `/comunicados` (admin) {titulo,cuerpo,categoria}.
- **documentos**: GET `/documentos` (auth) metadatos · POST `/documentos` (admin) {nombre,contenido:dataURL} ≤2MB pdf/jpg/png · GET `/documentos/:id/descargar` (auth).
- **asambleas**: GET `/asambleas` (auth) · POST `/asambleas` (admin) {titulo,fecha,lugar,opciones:["Sí","No"]} estado "Convocada" · POST `/asambleas/:id/asistencia` (residentes) toggle · POST `/asambleas/:id/voto` {opcion} 1 voto por persona (UNIQUE) · PATCH `/asambleas/:id` (admin) {estado:"Cerrada"}.
- **config**: GET `/config` (público: nombre_conjunto, logo_dataurl|null) · PUT `/config/logo` (admin) {logo:dataURL imagen ≤500KB}.
- **leads** (público): POST `/leads` {conjunto,ciudad,unidades,email,celular,plan,contacto_nombre} honeypot campo oculto `website` debe venir vacío; rate-limit 5/h IP.
- **kpis**: GET `/kpis` (admin,consejo) {recaudado_mes, pendiente_mes, pct_recaudo, morosos, reservas_hoy, tickets_abiertos, visitas_dentro}.

## Reglas de seguridad OBLIGATORIAS
1. Solo sentencias preparadas (nunca concatenar SQL).
2. Validador estricto propio `validar(schema, body)` por ruta: tipos, longitudes máximas, enums, trim. Rechazar campos extra.
3. Cabeceras globales middleware: `Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'` · `X-Content-Type-Options:nosniff` · `X-Frame-Options:DENY` · `Referrer-Policy:strict-origin-when-cross-origin` · `Permissions-Policy: camera=(self), geolocation=()` · HSTS solo si https.
4. CSRF: además de cookie SameSite=Lex→Lax, exigir header `X-Requested-With: fetch` en TODAS las mutaciones (lo envía assets/api.js); si falta → 403.
5. Rate-limit en memoria por IP: login 5/min; escrituras 60/min; leads 5/h.
6. Body limit JSON 1MB (fotos viajan aparte ≤300KB c/u ya como dataURL dentro del body de visitas → permitir 900KB solo esa ruta).
7. Errores: nunca filtrar stack al cliente; log consola + tabla auditoria.
8. auditoria(id,usuario_id,accion,detalle,ip,creado_en) en login ok/fallo, cambios de usuarios, pagos, aprobaciones, alertas atendidas.
9. Servir estáticos desde public/ con index false, dotfiles deny.
10. Cerrar sesión expirada automáticamente (limpieza en cada request autenticado).

## Seed (script npm run seed)
Usuarios pass "demo1234" (mostrar credenciales en login.html): administrador doc 1020001 Jorge Ramírez; consejo 1020002 Marta Ruiz T3-204; porteria 1020003 Carlos Vega; copropietario 1020004 Ana María Gómez T2-502; arrendatario 1020005 Pedro Salas T2-103; + Carlos Peña T1-301 (en mora), Luis Ospina T4-401 suspendido. Unidades T1-301..T4-502 coeficientes. Zonas: Salón Social 40p $50.000/h; Zona BBQ $30.000; Piscina gratis; Gimnasio gratis; Cancha sintética $20.000. Pagos julio Pagado PG-88212 todas las unidades activas; agosto Pendiente. Reservas R-seed (Salón Social 29 ago Confirmada Ana; BBQ 30 ago Pendiente Pedro). PQRS T-0398 ruido En revisión Ana; T-0351 resuelto. Comunicados 3 (asamblea/servicio/convivencia). Asamblea "Extraordinaria fachada" 12 sep Convocada opciones Sí/No. Visitas 4 semillas (2 Dentro). Alerta ninguna.

## Frontend (server/public/assets/api.js — lo crean los agentes de frontend)
Helper global `TC.api(path,{method,body})`: fetch same-origin, header X-Requested-With:fetch, Content-Type application/json, parsea formato uniforme, lanza Error(message). Tema (tc-theme) sigue en localStorage; TODO lo demás migra a API. Login.html usa POST /api/auth/login real (credenciales demo visibles). Sesión expirada → redirect login.html.

# CONTRATO v2 — Extensión seguridad, autorregistro y operación admin

## Sesiones y "Recordarme"
- `POST /api/auth/login` acepta además `recordarme:boolean`.
  - false (default): cookie SIN Max-Age (muere al cerrar navegador) + expiración servidor `sesion_minutos` (config, default 60).
  - true: cookie Max-Age = `recordarme_horas`*3600 + expiración servidor idéntica. `recordarme_horas` config default 12 con TOPE DURO 12 h validado server-side (nunca más).
- Respuesta login incluye `{usuario:{...,debe_cambiar_clave}, sesion:{expira_en_ms}}`.

## Autorregistro (público)
- `POST /api/auth/registro` {nombre,tipo_doc,documento,email,celular,password,tipo:"copropietario"|"arrendatario",torre,apto}
  - Rate-limit 5/h por IP. Valida password ≥ `password_min` (config, default 8). Documento/email UNIQUE → 409 YA_REGISTRADO.
  - Crea usuario estado "Pendiente aprobación" con hash real (NO temporal). Resuelve unidad por (torre,apto); si no existe la CREA (así el primer registro incorpora torres/apartamentos nuevos). Audita.
  - Login de cuenta "Pendiente aprobación" → 403 CUENTA_PENDIENTE ("tu acceso espera aprobación del administrador"); "Suspendido" → 403 CUENTA_SUSPENDIDA.

## Cambio de contraseña propio (cierra H-2 auditoría)
- `POST /api/auth/cambiar-clave` (auth) {actual,nueva}: verifica scrypt actual, aplica política `password_min`, distinta de la actual; revoca OTRAS sesiones del usuario; audita. Si usuario.debe_cambiar_clave=1 este endpoint es obligatorio para cualquier otra mutación (middleware: si debe_cambiar_clave y ruta != /auth/* → 403 DEBE_CAMBIAR_CLAVE).

## Parámetros de seguridad (solo administrador)
- `GET /api/config/seguridad` (admin) → {sesion_minutos, recordarme_horas, intentos_login, bloqueo_minutos, password_min}.
- `PUT /api/config/seguridad` (admin) mismos campos; límites: sesion_minutos 10–720, recordarme_horas 1–12 (DURO), intentos_login 3–10, bloqueo_minutos 5–120, password_min 6–64. Persistidos en tabla config (JSON), aplicados DINÁMICamente por auth/rate-limit (leer en cada uso, sin cache larga). Audita cambios.

## Unidades y torres (admin/consejo lectura)
- `GET /api/unidades?torre=` → {unidades:[{id,torre,apto,coeficiente,propietario_nombre|null,estado_usuario}],torres:[{torre,total}],total} (agrupable por torre; ?torre filtra exacto).
- `POST /api/unidades` (admin) {torre,apto,coeficiente?≤1} UNIQUE(torre,apto) → 409 UNIDAD_EXISTE.

## Estadísticas comunidad
- `GET /api/comunidad/stats` (admin,consejo) → {total,copropietarios,arrendatarios,pendientes,suspendidos,torres,unidades,unidades_ocupadas}.

## Pagos: asignación manual (admin)
- `POST /api/pagos/asignar` (admin) {documento|usuario_id, periodo "YYYY-MM", concepto? default "Administración", valor? int>0 default 250000}
  - Usuario NO encontrado por documento → 404 USUARIO_NO_REGISTRADO {documento, sugerencia:"invitar"} (frontend ofrece abrir modal Invitar precargado).
  - Si unidad ya tiene ese periodo Pagado → 409 PERIODO_PAGADO. Si existe Pendiente → actualiza concepto/valor. Si no existe → INSERT Pendiente metodo "Manual". Audita con objetivo.

## Comunicados y asambleas (UI admin sobre rutas existentes)
- Ya existen POST /comunicados {titulo,cuerpo,categoria} y POST /asambleas {titulo,fecha,lugar,opciones[]} + PATCH /asambleas/:id {estado:"Cerrada"} + GET resultados vía /asambleas (incluir conteo votos y asistencia en respuesta lista: votos:[{opcion,count}], asistentes:n).

## Seed v2 (ampliar seed.js sin borrar lo demás)
- config/seguridad defaults arriba. Usuarios nuevos: 1020008 copropietario "Pendiente aprobación" (ver demo aprobar), 1020009 arrendatario Pendiente. Torres T1–T4 existentes + unidades extra para filtros.

## v2.1 — Pagos PSE reales (Wompi) — F1/F2/F3/F4 implementados
- Tabla `transacciones_pse` (referencia UNIQUE, monto_centavos, txn_id_pasarela, estado Creada/Pendiente/Aprobada/Rechazada/Anulada/Expirada, raw_evento).
- `POST /api/pagos/pse/iniciar` (residentes) {periodo} → 201 {checkout_url firmada SHA256(ref+centavos+COP+integrity_secret), referencia}. Reanuda si ya hay transacción activa. Requiere PAYMENTS_PROVIDER=wompi + llaves; sin config responde 409 PROVEEDOR_NO_CONFIGURADO.
- `POST /api/pagos/webhook/wompi` (público, EXENTO de CSRF, autenticado por checksum SHA256 de signature.properties+timestamp+events_secret). Idempotente por txn_id. Verifica amount_in_cents contra la BD local (MONTO_INCONSISTENTE si difiere). APPROVED→cuota Pagado atómico · DECLINED/ERROR→Rechazada · VOIDED/ANULLED→Anulada · PENDING→Pendiente. Firma inválida→401.
- `GET /api/pagos/pse/:referencia/estado` (dueño o staff) → estado local de la transacción.
- Expiración lazy: transacciones Creada/Pendiente >PAGOS_TIMEOUT_MINUTOS (default 30) → Expirada.
- El simulador `POST /pagos/pse` se DESACTIVA automáticamente cuando provider=wompi (409 PAGO_REAL_ACTIVO).
- Pruebas: `npm run test:pse` (20 aserciones E2E sobre instancia aislada).
