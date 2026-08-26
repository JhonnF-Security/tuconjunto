'use strict';
// Prueba E2E de la integración Wompi F1-F3 contra una instancia aislada.
// Uso: node e2e-pse.mjs   (arranca su propio servidor en 8093 con BD temporal)

import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8093';
const DB = '/tmp/opencode/pse-e2e.db';
const SECRETO_INT = 'test_integrity_xxx';
const SECRETO_EVT = 'test_events_xxx';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
let paso = 1;
function ok(cond, msg) {
  console.log(`${cond ? '✅' : '❌'} ${paso++}. ${msg}`);
  if (!cond) process.exit(1);
}

for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(DB + s, { force: true }); } catch {} }

const env = {
  ...process.env,
  DB_FILE: DB,
  PORT: '8093',
  HOST: '127.0.0.1',
  PAYMENTS_PROVIDER: 'wompi',
  WOMPI_ENV: 'sandbox',
  WOMPI_PUBLIC_KEY: 'pub_test_xxx',
  WOMPI_PRIVATE_KEY: 'priv_test_xxx',
  WOMPI_INTEGRITY_SECRET: SECRETO_INT,
  WOMPI_EVENTS_SECRET: SECRETO_EVT,
  APP_PUBLIC_BASE_URL: BASE,
};
execSync('node src/seed.js', { cwd: '/root/agency-agents/tu-conjunto/server', env, stdio: 'pipe' });
console.log('— seed listo —');

const srv = spawn('node', ['src/index.js'], { cwd: '/root/agency-agents/tu-conjunto/server', env, stdio: 'pipe' });

async function esperar() {
  for (let i = 0; i < 20; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('servidor no arrancó');
}

async function login(doc, clave = 'demo1234') {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ documento: doc, password: clave }),
  });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return { cookie, json: await r.json() };
}
const api = (cookie, metodo, ruta, cuerpo) => fetch(`${BASE}${ruta}`, {
  method: metodo,
  headers: { 'Content-Type': 'application/json', ...(cuerpo ? {} : {}), ...(metodo !== 'GET' ? { 'X-Requested-With': 'fetch' } : {}) , ...(cookie ? { Cookie: cookie } : {}) },
  body: cuerpo ? JSON.stringify(cuerpo) : undefined,
}).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

try {
  await esperar();
  ok(true, 'servidor de prueba arriba en 8093 (PAYMENTS_PROVIDER=wompi)');

  // Admin asigna cuota nueva al copropietario 1020004
  const admin = await login('1020001');
  ok(admin.json.ok === true, 'login administrador');
  const asg = await api(admin.cookie, 'POST', '/api/pagos/asignar', { documento: '1020004', periodo: '2027-01', valor: 250000 });
  ok(asg.status === 201 || asg.status === 200, `cuota 2027-01 creada (${asg.status})`);

  // Residente inicia pago real
  const resi = await login('1020004');
  ok(resi.json.ok === true, 'login copropietario');
  const ini = await api(resi.cookie, 'POST', '/api/pagos/pse/iniciar', { periodo: '2027-01' });
  const iniD = ini.json.data || ini.json;
ok(ini.status === 201 && !!iniD.checkout_url, 'F2 iniciar → checkout_url entregada');

  // Validar firma de integridad y parámetros del checkout
  const url = new URL(iniD.checkout_url);
  const ref = url.searchParams.get('reference');
  const centavos = Number(url.searchParams.get('amount-in-cents'));
  const firma = url.searchParams.get('signature:integrity');
  ok(url.origin + url.pathname === 'https://checkout.wompi.co/p/', 'checkout apunta a Wompi');
  ok(centavos === 25000000, `monto server-side correcto (${centavos} centavos)`);
  ok(firma === sha256(`${ref}${centavos}COP${SECRETO_INT}`), 'firma de integridad SHA256 válida');

  // Estado inicial
  const est0 = await api(resi.cookie, 'GET', `/api/pagos/pse/${ref}/estado`);
  ok((est0.json.data||est0.json)?.transaccion?.estado === 'Creada', `transacción en estado Creada`);

  // Reanudar (doble clic): misma referencia, sin duplicar
  const ini2 = await api(resi.cookie, 'POST', '/api/pagos/pse/iniciar', { periodo: '2027-01' });
  const ini2D = ini2.json.data || ini2.json;
  ok(ini2D.referencia === ref && ini2D.reanudada === true, 'doble iniciar reanuda la misma transacción');

  // Simulador desactivado con pasarela real
  const sim = await api(resi.cookie, 'POST', '/api/pagos/pse', { periodo: '2027-01' });
  ok(sim.status === 409 && sim.json.error.code === 'PAGO_REAL_ACTIVO', 'simulador bloqueado cuando provider=wompi');

  // F3 · Webhook APROBADO con checksum válido
  const ts = Math.floor(Date.now() / 1000);
  const txnOk = { id: '119000-test-1', status: 'APPROVED', amount_in_cents: centavos, reference: ref };
  const props = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents', 'transaction.reference'];
  const checksum = sha256(txnOk.id + txnOk.status + String(txnOk.amount_in_cents) + txnOk.reference + ts + SECRETO_EVT).toUpperCase();
  const evento = () => ({
    event: 'transaction.updated', data: { transaction: { ...txnOk } },
    sent_at: new Date().toISOString(), timestamp: ts,
    signature: { properties: props, checksum },
  });

  // Sin X-Requested-With a propósito: el webhook está exento de CSRF.
  const wh = await fetch(`${BASE}/api/pagos/webhook/wompi`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(evento()),
  }).then(r => r.json());
  ok(wh.ok === true && wh.estado_aplicado === 'APPROVED', 'webhook APPROVED aplicado (exento de CSRF)');

  // La cuota quedó Pagada y la transacción Aprobada
  const pagos = await api(resi.cookie, 'GET', '/api/pagos');
  const cuota = (pagos.json.data||pagos.json).pagos.find(p => p.periodo === '2027-01');
  ok(cuota?.estado === 'Pagado' && cuota.referencia === ref, `cuota marcada Pagado con referencia ${cuota?.referencia}`);
  const est1 = await api(resi.cookie, 'GET', `/api/pagos/pse/${ref}/estado`);
  const t1 = (est1.json.data || est1.json).transaccion;
  ok(t1.estado === 'Aprobada' && t1.txn_id_pasarela === '119000-test-1', 'transacción Aprobada con txn id guardado');

  // Reentrega idéntica → idempotente
  const wh2 = await fetch(`${BASE}/api/pagos/webhook/wompi`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(evento()),
  }).then(r => r.json());
  ok(wh2.ok === true && wh2.idempotente === true, 'reentrega del webhook es idempotente');

  // Firma inválida → rechazo
  const malo = evento(); malo.signature.checksum = 'DEADBEEF';
  const wh3 = await fetch(`${BASE}/api/pagos/webhook/wompi`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(malo),
  });
  ok(wh3.status === 401, 'checksum inválido rechazado con 401');

  // Monto alterado sobre transacción NO terminal (con firma válida): la BD manda
  await api(admin.cookie, 'POST', '/api/pagos/asignar', { documento: '1020004', periodo: '2027-03', valor: 250000 });
  const ini3 = await api(resi.cookie, 'POST', '/api/pagos/pse/iniciar', { periodo: '2027-03' });
  const ref3 = (ini3.json.data || ini3.json).referencia;
  const ts2 = Math.floor(Date.now() / 1000);
  const txnMal = { id: '119000-test-2', status: 'APPROVED', amount_in_cents: 100, reference: ref3 };
  const chkMal = sha256(txnMal.id + txnMal.status + String(txnMal.amount_in_cents) + txnMal.reference + ts2 + SECRETO_EVT).toUpperCase();
  const wh4 = await fetch(`${BASE}/api/pagos/webhook/wompi`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'transaction.updated', data: { transaction: txnMal }, sent_at: new Date().toISOString(), timestamp: ts2, signature: { properties: props, checksum: chkMal } }),
  }).then(r => r.json());
  ok(wh4.error?.code === 'MONTO_INCONSISTENTE', 'monto alterado detectado contra la BD local');
  const cuota3 = (await api(resi.cookie, 'GET', '/api/pagos')).json.data.pagos.find(p => p.periodo === '2027-03');
  ok(cuota3.estado === 'Pendiente', 'cuota sigue Pendiente tras intento con monto alterado');

  // DECLINED sobre transacción ya terminal → ignorado sin romper estado
  const ts3 = Math.floor(Date.now() / 1000);
  const txnDec = { id: '119000-test-3', status: 'DECLINED', amount_in_cents: centavos, reference: ref };
  const chk3 = sha256(txnDec.id + txnDec.status + String(txnDec.amount_in_cents) + txnDec.reference + ts3 + SECRETO_EVT).toUpperCase();
  const wh5 = await fetch(`${BASE}/api/pagos/webhook/wompi`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'transaction.updated', data: { transaction: txnDec }, sent_at: new Date().toISOString(), timestamp: ts3, signature: { properties: props, checksum: chk3 } }),
  }).then(r => r.json());
  ok(wh5.ok === true && (wh5.ignorado || wh5.idempotente), 'evento tardío sobre transacción terminal se ignora limpio');

  const cuotaFinal = (await api(resi.cookie, 'GET', '/api/pagos')).json.data.pagos.find(p => p.periodo === '2027-01');  ok(cuotaFinal.estado === 'Pagado', 'estado final intacto: Pagado');

  console.log('\n🎉 TODAS LAS PRUEBAS PASARON');
} catch (e) {
  console.error('💥 FALLO:', e.message);
  process.exitCode = 1;
} finally {
  srv.kill('SIGTERM');
}
