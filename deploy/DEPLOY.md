# Despliegue en producción — TuConjunto

## Requisitos
- VPS Ubuntu 22.04/24.04 (1 vCPU / 2 GB / 40 GB SSD es suficiente para decenas de conjuntos)
- Dominio con registro **A** apuntando a la IP del VPS (espera propagación DNS antes de Certbot)
- Puertos abiertos: 80, 443 (SSH 22 solo con llave)

## Instalación automática (recomendada)
```bash
# desde tu máquina, copia el proyecto al VPS:
rsync -av --exclude node_modules --exclude data --exclude backups --exclude tls \
      ./tu-conjunto/ root@IP-DEL-VPS:/opt/tuconjunto/

# en el VPS:
cd /opt/tuconjunto/deploy
chmod +x deploy.sh && sudo ./deploy.sh tudominio.com
```
El script instala Node 20 + Nginx + Certbot, crea el servicio systemd endurecido,
activa firewall (ufw 22/80/443), TLS gratis, programa backups diarios y deja la app en `https://tudominio.com`.

**DNS**: se emite certificado para el dominio apex. Si quieres `www`, crea también ese registro A/CNAME y ejecuta:
`sudo certbot --nginx -d tudominio.com -d www.tudominio.com --redirect`

## Post-instalación obligatoria
1. Crea tu administrador real (NO uses datos demo en producción; `npm run seed` **BORRA la base completa** e instala demo con clave `demo1234` — solo para pruebas locales):
   ```bash
   cd /opt/tuconjunto/server
   sudo -u tuconjunto npm run create-admin -- --documento TU_DOCUMENTO --nombre "Tu Nombre"
   # imprime una contraseña temporal UNA sola vez; cámbiala en el primer ingreso
   ```
2. Entra a `/login.html` con esa contraseña temporal, cambia la contraseña.
3. Configura los parámetros de Seguridad según el conjunto (sesión, recordarme ≤12 h, intentos).
4. Verifica `/api/health` y un flujo completo desde un teléfono (cámara de portería requiere HTTPS).

## Operación
| Tarea | Comando |
|---|---|
| Estado | `systemctl status tuconjunto` |
| Reiniciar | `systemctl restart tuconjunto` |
| Logs | `journalctl -u tuconjunto -f` |
| Backup manual | `cd /opt/tuconjunto/server && sudo -u tuconjunto npm run backup` |
| Restaurar backup | ver procedimiento abajo |

### Restaurar backup (procedimiento seguro)
```bash
sudo systemctl stop tuconjunto
cd /opt/tuconjunto/server/data
sudo cp backups/tuconjunto-FECHA.db tuconjunto.db        # sobreescribe
sudo rm -f tuconjunto.db-wal tuconjunto.db-shm           # ¡obligatorio! evita mezclar estados
sudo sqlite3 tuconjunto.db "PRAGMA integrity_check;"     # debe responder "ok"
sudo chown tuconjunto:tuconjunto tuconjunto.db*
sudo systemctl start tuconjunto
```

## Actualizar la app
```bash
rsync -av --exclude node_modules --exclude data --exclude backups --exclude tls --exclude .env ./ root@VPS:/opt/tuconjunto/
systemctl restart tuconjunto
```
El esquema de BD se crea/actualiza idempotente al arrancar (`CREATE IF NOT EXISTS`).

## Escala futura (cuando pases de ~50 conjuntos o necesites alta disponibilidad)
- Migrar SQLite → PostgreSQL (el contrato de API no cambia; solo capa db.js)
- Separar notificaciones (email/WhatsApp) en worker aparte
- Backups offsite: `rclone copy backups/ b2:tuconjunto-backups`

## Costos resumen
- VPS: US$5–12/mes · Dominio: US$10–15/año · TLS: gratis · Email: gratis hasta escala media
- PSE real: 2,5 %–3,5 % por transacción + fijo (cotizar Wompi/ePayco/PayU/Bold)
