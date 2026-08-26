# Integración de pagos PSE reales — TuConjunto

**Estado: F1–F4 IMPLEMENTADOS Y PROBADOS** (20 aserciones E2E en `npm run test:pse`).
Para activarlos solo falta la cuenta real:

1. Contratar comercio Wompi con el NIT del conjunto.
2. Llenar las llaves en `server/.env` (ver abajo) con `WOMPI_ENV=sandbox`.
3. Configurar en el dashboard de Wompi la URL de eventos:
   `https://tudominio.co/api/pagos/webhook/wompi`
4. Probar un pago real en sandbox y revisar `auditoria` + logs.
5. Cambiar a `production` con llaves definitivas.

Estado actual del simulador: sigue disponible para demos; **se desactiva
automáticamente** cuando `PAYMENTS_PROVIDER=wompi` está configurado.

## Por qué Wompi (recomendada)

| Criterio | Wompi | Bold | ePayco | PayU |
|---|---|---|---|---|
| Checkout | Redirect/form (compatible con CSP actual) | Redirect/API | Widget JS | API REST pesada |
| Firma integridad | SHA256 server-side (1 línea) | HMAC-SHA256 | SHA256 | MD5 legacy |
| Webhook | 1 evento `transaction.updated` + checksum | CloudEvents JSON | confirmation URL | state_pol |
| Consulta fallback | `GET /v1/transactions/{id}` | por intention id | por ref_payco | Reports API |
| Sandbox | Sí, llaves `pub_test_` | Sí | Sí | Sí |

Alternativas válidas: Bold (API moderna), ePayco, PayU (la más compleja).

## Lo que ya cumple el proyecto (reutilizable tal cual)

- Monto SIEMPRE del lado servidor (el cliente no puede alterar el valor).
- Idempotencia de doble clic: transacción SQLite atómica + `UNIQUE(unidad_id,periodo)`
  → reintento devuelve 409 `SIN_CUOTA_PENDIENTE`.
- Referencia visible `PG-XXXXX`, auditoría de pagos, cartera y KPIs derivados del estado.
- Seguridad lista para webhook: TLS, rate-limiting, logs de auditoría.

## Fases para activar la cuenta real

- **F0 — Cuenta**: contratar comercio Wompi con NIT del conjunto; dominio con HTTPS
  público (obligatorio para webhooks). Obtener llaves sandbox.
- **F1 — Modelo**: tabla `transacciones_pse(id, pago_id, referencia UNIQUE,
  monto_centavos, pasarela, txn_id_pasarela, estado[Creada|Pendiente|Aprobada|
  Rechazada|Anulada|Expirada], banco, raw_evento JSON, timestamps)` y estado
  intermedio `Procesando` en `pagos`.
- **F2 — Inicio**: `POST /api/pagos/pse/iniciar` {periodo} → crea transacción y
  responde `checkout_url` firmada:
  `SHA256(referencia + monto_centavos + "COP" + integrity_secret)`. El frontend
  redirige a `https://checkout.wompi.co/p/?public-key=...`.
- **F3 — Webhook**: `POST /api/pagos/webhook/wompi` (público, sin sesión, exento de
  CSRF): validar checksum SHA256(propiedades+timestamp+events_secret), verificar
  monto/moneda contra la fila local, aplicar idempotente por `transaction.id`
  (Aprobada → `Pagado`; Rechazada → cuota vuelve a `Pendiente`; VOIDED → Anulada).
  Responder 200 inmediato y guardar el payload crudo.
- **F4 — Consistencia**: endpoint de consulta a Wompi con llave privada (fallback si
  se pierde el evento); expirar transacciones `Creada` >30 min liberando la cuota;
  página de retorno que consulta estado (nunca confiar en el redirect).
- **F5 — Frontend**: reemplazar modal simulado por redirect + pantalla de resultado;
  pruebas E2E en sandbox; go-live con llaves `pub_prod_`.

## Variables de entorno (server/.env)

Ya definidas en `.env.example`:

```bash
PAYMENTS_PROVIDER=none            # none (simulado) | wompi
WOMPI_ENV=sandbox                 # sandbox | production
WOMPI_PUBLIC_KEY=
WOMPI_PRIVATE_KEY=
WOMPI_INTEGRITY_SECRET=
WOMPI_EVENTS_SECRET=
APP_PUBLIC_BASE_URL=https://tuconjunto.tudominio.co
PAGOS_TIMEOUT_MINUTOS=30
```

Mientras `PAYMENTS_PROVIDER=none`, el flujo simulado sigue operando (útil para
demo/pruebas internas). El cambio a `wompi` se activa implementando F1–F3.

## Costos referenciales

PSE real: ~2,5 %–3,5 % por transacción + fijo. Cotizar Wompi/ePayco/PayU/Bold
con el volumen mensual esperado del conjunto.
