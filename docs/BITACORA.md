# Bitácora de TuConjunto

> Registro diario de trabajo: qué se hizo, por qué, y qué queda pendiente.
> Regla: **una entrada por día de trabajo**, la más nueva arriba. Usa la plantilla del final.

---

## 2026-08-26 · Estabilización local + repositorio

**Qué se hizo**
- Diagnosticado y resuelto problema de acceso desde navegador: había procesos servidor huérfanos (x2) y una BD fantasma causada por correr `seed.js` con el servidor vivo
- **Nuevo guard en `src/seed.js`**: detecta vía /proc si otro proceso tiene la BD abierta y se niega a correr (evita el error clase "datos fantasma"). Orden correcto documentado: detener → seed → arrancar
- Regenerada BD demo completa y verificado login de los 5 roles
- Instalado git; creado repositorio del proyecto con `.gitignore` que excluye secretos (.env), BD con PII (data/), certificados TLS y backups

**Lección del día**
Nunca ejecutar comandos destructivos/regenerativos contra una BD mientras el servidor la tiene abierta. Ahora el propio script lo verifica.

**Pendiente**
- Conectar remoto GitHub y primer push

---

## 2026-08-25 · Pagos PSE reales (Wompi) F1–F4 + validación integral

**Qué se hizo**
- Validación funcional completa de los 5 roles y sus módulos (curl E2E): auth, pagos, reservas, PQRS, visitas, alertas, KPIs, cartera, asambleas, documentos — RBAC verificado positivo y negativo
- 3 auditorías en paralelo (seguridad OWASP, readiness PSE, paquete de despliegue)
- **Fixes de seguridad aplicados y verificados:**
  - A-1: suspensión de usuario ahora invalida sesiones activas al instante (`middleware.js requireAuth` → CUENTA_INACTIVA)
  - A-2: contraseña temporal ya no = documento; ahora aleatoria de 12 chars (`usuarios.js`) + contrato actualizado
  - M-2: botón de pánico con rate-limit 3/5min + deduplicación (`alertas.js`)
  - B-5: timing oracle en login eliminado (hash dummy scrypt) (`auth.js`)
- **5 bloqueantes de despliegue corregidos:**
  1. nginx vhost inicial solo puerto 80 → `nginx -t` pasa y Certbot puede emitir (chicken-and-egg resuelto)
  2. Esquema BD idempotente al arranque (`crearEsquema` en index.js) — instalación limpia sin seed funciona
  3. Nuevo `scripts/create-admin.js` + `npm run create-admin` — semilla del primer administrador
  4. Banner destructivo de deploy.sh eliminado (sugería flag inexistente + seed borraba producción)
  5. `TRUST_PROXY=1` forzado con sed + HOST=127.0.0.1 + firewall ufw en deploy.sh
- Hardening systemd ampliado (14 directivas), MemoryMax 512M→768M
- DEPLOY.md: procedimiento seguro de restauración de backups (borrar -wal/-shm, integrity_check)
- **Pagos Wompi implementados (F1–F4):**
  - F1: tabla `transacciones_pse` (referencia UNIQUE, máquina de estados, raw_evento)
  - F2: `POST /pagos/pse/iniciar` — checkout firmado SHA256(ref+centavos+COP+secreto), reanudable
  - F3: webhook público exento de CSRF, checksum validado, idempotente por txn_id, monto verificado contra BD local
  - F4: `GET /pagos/pse/:ref/estado` + expiración lazy 30 min
  - Simulador auto-desactivado cuando provider=wompi (409 PAGO_REAL_ACTIVO)
  - Frontend residente.html: intenta flujo real y cae al simulador sin configuración
- Suite E2E propia: `scripts/prueba-e2e-pse.mjs` (`npm run test:pse`) — **20/20 pasando**

**Lecciones**
Webhook firmado = fuente de verdad; redirect es decoración. Monto SIEMPRE server-side. Idempotencia por transaction.id porque las pasarelas reintentan.

**Pendiente**
Cuenta Wompi real con NIT del conjunto · despliegue a VPS

---

## Plantilla para nuevas entradas

```markdown
## AAAA-MM-DD · Título corto

**Qué se hizo**
-

**Lecciones** (opcional)
-

**Pendiente**
-
```
