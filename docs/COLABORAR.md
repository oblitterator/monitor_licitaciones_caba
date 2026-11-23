# Cómo colaborar con el Monitor de Licitaciones CABA

Esta guía es para quienes se suman al grupo, sepan mucho o poco de programación. Si algo no se entiende o está
desactualizado, avisá o mandá un PR que lo arregle: eso también es colaborar.

## Qué es el proyecto

El Monitor lee todos los días el Boletín Oficial de la Ciudad de Buenos Aires, baja los PDFs de la sección
Licitaciones y saca de cada acto quién ganó, por cuánto, contra cuántos oferentes y con qué procedimiento. Con eso
arma **señales** (oferta única, concentración, contrataciones directas, posible fraccionamiento, etc.) y las
publica en un sitio web. Las señales sirven para priorizar qué revisar; no prueban ninguna irregularidad.

### Mapa del repo

| Carpeta | Qué hay |
|---|---|
| `monitor_licitaciones/` | Paquete Python: cliente de la API del Boletín, descarga de PDFs, parser de actos, resolución de CUIT, respaldo opcional con LLM y la línea de comandos (`cli.py`) |
| `sql/` | Esquemas, funciones y vistas de Postgres. Se aplican en orden con `init-db`. `060_web.sql` crea lo que usa el sitio |
| `web/` | Sitio público en Next.js. Lee Postgres directo. Ver `web/README.md` |
| `deploy/` | Producción en un servidor: Docker Compose y scripts de puesta en marcha, actualización, ingesta y restauración |
| `notebooks/` | Análisis de calidad y de señales (Jupyter). Solo leen la base |
| `tests/` | Pruebas del paquete Python, con textos reales del Boletín |

---

## Correrlo en tu máquina

### Requisitos

- Python 3.10 o más nuevo.
- PostgreSQL 16 con la extensión `pg_trgm` (viene en los paquetes oficiales y en la imagen `postgres:16` de
  Docker).
- Node.js 24 y pnpm, solo si vas a tocar el sitio.
- Git.

Si tenés Docker, la forma más fácil de tener un Postgres igual al de producción es:

```bash
docker run -d --name mlc-db -p 127.0.0.1:5432:5432 \
  -e POSTGRES_PASSWORD=local -e POSTGRES_DB=boletin_oficial_caba postgres:16
```

### Instalar el paquete

```bash
git clone https://github.com/oblitterator/monitor_licitaciones_caba.git
cd monitor_licitaciones_caba
python -m venv .venv
source .venv/bin/activate            # en Windows: .venv\Scripts\activate
pip install -e ".[test]"
export MLC_DSN="postgresql://postgres:local@127.0.0.1:5432/boletin_oficial_caba"
```

### Restaurar el dump

La base completa pesa unos 850 MB (el dump comprimido, menos de 100 MB). **Pedíselo a quienes mantienen el
proyecto**: no está en el repo y **nunca lo commitees** (el `.gitignore` ya ignora `*.dump`, pero fijate igual).

```bash
pg_restore --no-owner --no-privileges -d boletin_oficial_caba monitor_licitaciones_caba.dump
python -m monitor_licitaciones init-db                          # pone al día esquemas y vistas
psql "$MLC_DSN" -c "SELECT web.refrescar();"                    # vistas del sitio
```

Si no tenés el dump podés arrancar de cero: `init-db` crea la estructura vacía y el scraper la llena.

### Correr el scraper en un rango chico

No hace falta bajar años: con uno o dos días alcanza para probar.

```bash
python -m monitor_licitaciones -v boletines --desde 2026-11-20 --hasta 2026-11-20
python -m monitor_licitaciones -v pdfs --limite 50        # 6 descargas a la vez, la API es pública: no lo subas
python -m monitor_licitaciones -v parsear
python -m monitor_licitaciones resolver
psql "$MLC_DSN" -c "SELECT web.refrescar();"
python -m monitor_licitaciones calidad
```

Es exactamente lo que hace la corrida diaria de producción (`deploy/ingesta/corrida.sh`), que también se puede correr
a mano: `bash deploy/ingesta/corrida.sh 2026-11-20 2026-11-20`.

### Correr el sitio

```bash
cd web
pnpm install
cp .env.example .env.local     # completá DATABASE_URL con tu base local
pnpm dev                       # http://localhost:3000
```

Las lecturas se cachean una hora: si cargaste datos nuevos y no los ves, reiniciá `pnpm dev`.

### Correr las pruebas

```bash
# Python, sin base ni red
python -m pytest tests/test_parser.py tests/test_descarga.py tests/test_boletines.py tests/test_llm.py tests/test_extraccion.py
# Python, integración: necesita una base DESCARTABLE (el test la borra)
MLC_TEST_DSN="postgresql://postgres:local@127.0.0.1:5432/mlc_test" python -m pytest
# Sitio
cd web && pnpm typecheck && pnpm lint && pnpm test
```

---

## Desplegar y operar

Producción es **un solo servidor chico** con Docker Compose y Cloudflare gratis adelante. Corren cinco contenedores:

| Servicio | Qué hace |
|---|---|
| `db` | Postgres 16. Los datos viven en el volumen `pgdata`. Solo escucha en `127.0.0.1` del servidor |
| `web` | El sitio (Next.js en Node), con usuario de solo lectura `monitor_web` |
| `ingesta` | Todos los días a las 07:30 (`INGESTA_HORA`) baja boletines, PDFs, parsea, resuelve CUIT y refresca las vistas |
| `backup` | Todas las noches a las 03:30 (`BACKUP_HORA`) hace `pg_dump` y lo sube a Cloudflare R2 |
| `cloudflared` | Túnel de Cloudflare: el público entra por ahí, con TLS de Cloudflare. El servidor no abre puertos de entrada |

El sitio también se puede desplegar en Cloudflare Workers (ver `web/README.md`), pero la base igual necesita un
servidor: con la base completa no entra en los planes gratis de Postgres administrado.

### 1. Comprar el servidor

Cualquier VPS con 2 vCPU, 4 GB de RAM y 40 GB de disco alcanza; por ejemplo un Hetzner CX22 o el equivalente que tengan hoy (unos € 4,5 por mes).
Elegí **Ubuntu 24.04** y cargá tu **llave SSH pública** al crearlo (no uses contraseña).

### 2. Seguridad básica

Entrá como root (`ssh root@IP`) y:

```bash
# usuario propio con sudo y tu llave
adduser --disabled-password --gecos "" operador
usermod -aG sudo operador
mkdir -p /home/operador/.ssh && cp ~/.ssh/authorized_keys /home/operador/.ssh/
chown -R operador:operador /home/operador/.ssh && chmod 700 /home/operador/.ssh
passwd operador                      # contraseña para sudo (guardala en el gestor del grupo)

# SSH solo con llave y sin root
cat > /etc/ssh/sshd_config.d/10-endurecer.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
systemctl restart ssh

# firewall: todo cerrado de entrada salvo SSH
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw enable

# actualizaciones de seguridad automáticas
apt update && apt -y upgrade
apt -y install unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades
```

Antes de cerrar la sesión de root, probá en otra terminal que `ssh operador@IP` funciona.

El sitio no necesita ningún puerto abierto (entra por el túnel). Postgres y la web publican puertos solo en
`127.0.0.1`; nunca los cambies a `0.0.0.0`, porque Docker se saltea `ufw`.

### 3. Instalar Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker operador      # salí y volvé a entrar para que tome el grupo
docker compose version
```

### 4. Clonar y completar `.env`

```bash
git clone https://github.com/oblitterator/monitor_licitaciones_caba.git ~/monitor
cd ~/monitor
cp deploy/env.example deploy/.env
chmod 600 deploy/.env
nano deploy/.env
```

Cada variable tiene un comentario en `deploy/env.example`. Para las contraseñas usá `openssl rand -hex 24` (solo
letras y números, porque van dentro de URLs). `deploy/.env` **nunca** se commitea ni se pega en un chat: si se
filtra, cambiá las claves.

### 5. Crear el túnel de Cloudflare

1. Poné el dominio en Cloudflare (plan Free).
2. En **Zero Trust > Networks > Tunnels**, creá un túnel tipo *Cloudflared* y copiá el token en
   `CLOUDFLARE_TUNNEL_TOKEN`.
3. En el túnel, agregá un **Public hostname**: tu dominio (por ejemplo `licitaciones.example.org`) con servicio
   `HTTP` y URL `web:3000`.
4. Poné esa misma URL en `SITE_URL`.
5. Opcional: creá un widget de **Turnstile** para los formularios y completá `TURNSTILE_*` con
   `TURNSTILE_ENABLED=true`.

### 6. Crear el bucket de R2 para los backups

1. En **R2 > Create bucket**, creá por ejemplo `monitor-licitaciones-backups` y ponelo en `R2_BUCKET`.
2. En **R2 > Manage API tokens**, creá un token con permiso **Object Read & Write** solo sobre ese bucket. Copiá el
   *Access Key ID* y el *Secret Access Key* en `R2_ACCESS_KEY_ID` y `R2_SECRET_ACCESS_KEY`.
3. `R2_ENDPOINT` es `https://<ID de tu cuenta>.r2.cloudflarestorage.com` (está en la misma pantalla).

### 7. Primera puesta en marcha

Subí el dump al servidor (`scp archivo.dump operador@IP:~/`) y corré:

```bash
deploy/primera-vez.sh ~/monitor_licitaciones_caba.dump
```

El script construye las imágenes, levanta Postgres, restaura el dump, crea el usuario `monitor_web`, aplica `sql/`
en orden, corre `web.refrescar()` y levanta todo. Sin dump arranca con la base vacía. Se puede volver a correr.
Cuando terminó, borrá el dump del home: `rm ~/monitor_licitaciones_caba.dump`.

> **Ojo con la primera corrida.** El dump de noviembre de 2026 llega hasta agosto de 2024 y tiene unos 22.600 PDFs viejos todavía sin
> bajar. La primera corrida va a consultar todos los días desde ahí (unos minutos) y cada corrida baja hasta
> `INGESTA_LIMITE_PDFS` PDFs (2000), de los más nuevos a los más viejos, así que ponerse al día lleva un par de
> semanas. Es normal. Si querés acelerar, corré `deploy/ingesta-ahora.sh` varias veces a mano (de a una).

### 8. Ver que anda

```bash
docker compose -f deploy/docker-compose.yml ps          # todos "running"; web y db "healthy"
curl -s http://127.0.0.1:3000/salud                      # {"ok":true}
```

Después abrí tu dominio en el navegador.

### Dónde están los logs

```bash
cd ~/monitor
docker compose -f deploy/docker-compose.yml logs -f ingesta       # corrida diaria
docker compose -f deploy/docker-compose.yml logs --since 24h backup
docker compose -f deploy/docker-compose.yml logs -f web cloudflared db
```

Los logs rotan solos (hasta 50 MB por servicio). Cada ejecución de la ingesta también queda en la base, en
`ctl.ejecucion`, y cada error en `ctl.error`:

```bash
docker compose -f deploy/docker-compose.yml exec db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT id, comando, inicio, fin, ok, resumen FROM ctl.ejecucion ORDER BY id DESC LIMIT 10"'
```

Para enterarte si algo falla sin mirar logs, creá dos chequeos gratis en healthchecks.io (o similar) y poné sus
URLs en `AVISO_URL_INGESTA` y `AVISO_URL_BACKUP`: te mandan un mail si un día no llega el aviso.

### La corrida diaria

`deploy/ingesta/corrida.sh`, en este orden:

1. `boletines`: desde el último boletín cargado (mirando 7 días para atrás) hasta hoy.
2. `pdfs`: hasta `INGESTA_LIMITE_PDFS`, 6 descargas a la vez.
3. `parsear` y `resolver`.
4. `bac`: snapshot de Buenos Aires Compras, si `INGESTA_BAC=1`.
5. LLM (`llm-recolectar` y `llm-enviar`), **solo** si `LLM_HABILITADO=1` y hay `ANTHROPIC_API_KEY`.
6. `SELECT web.refrescar();`.

Si un paso falla, los demás siguen y el refresco corre igual. Para correrla ya:

```bash
deploy/ingesta-ahora.sh                          # lo normal
deploy/ingesta-ahora.sh 2026-11-01 2026-11-05    # un rango puntual
```

Nunca corren dos a la vez. El sitio cachea las lecturas una hora: los datos nuevos aparecen a más tardar una hora
después de la corrida.

### Backups y restauración

Todas las noches se sube un dump a `R2_BUCKET/backups/diario/`; los domingos, además, una copia a `semanal/`. Se
guardan los últimos 14 diarios y 8 semanales. Para ver los que hay:

```bash
docker compose -f deploy/docker-compose.yml run --rm --no-deps backup \
  sh -c 'aws --endpoint-url "$AWS_ENDPOINT_URL" s3 ls "s3://$R2_BUCKET/${R2_PREFIJO:-backups}/" --recursive'
```

Para restaurar (**borra la base actual**, te pide confirmación):

```bash
deploy/restaurar.sh ultimo                               # el último diario
deploy/restaurar.sh diario/boletin-2026-11-20.dump       # uno puntual
deploy/restaurar.sh ~/algun-archivo.dump                 # un archivo local
```

Para correr un backup ya: `docker compose -f deploy/docker-compose.yml exec backup backup.sh`.
Probá restaurar un backup en tu máquina de vez en cuando: un backup que nunca se restauró no es un backup.

### Actualizar a la última versión

```bash
deploy/actualizar.sh
```

Hace `git pull`, reconstruye las imágenes y reinicia. Si cambió algo en `sql/`, además corre `init-db` y
`web.refrescar()`.

### Cuando algo se rompe

| Síntoma | Qué mirar | Qué hacer |
|---|---|---|
| La ingesta falló | `logs ingesta`: la línea `FALLÓ` dice qué paso. Detalle en `ctl.error` | Si fue algo pasajero, `deploy/ingesta-ahora.sh`. Si se repite, abrí un issue con el log |
| La API del Boletín no responde | En el log, `fechas_error` o errores HTTP en `boletines` / `pdfs` | Nada: las fechas con error (de la última semana) y los PDFs fallidos (hasta 3 intentos) se reintentan solos en la corrida siguiente. Si dura más de una semana, avisá en el grupo y después recuperá con `deploy/ingesta-ahora.sh AAAA-MM-DD` |
| Disco lleno | `df -h`, `docker system df` | `docker image prune -af` y `docker builder prune -af`. Los logs ya rotan. Si es la base, hace falta un disco más grande |
| El sitio no carga | `ps` (¿`web` está `healthy`?), `curl -s 127.0.0.1:3000/salud`, `logs web cloudflared` | `{"ok":false}`: la web no llega a la base, mirá `logs db`. Sin respuesta: `docker compose ... restart web`. Anda local pero no afuera: es el túnel, revisá el token y el *public hostname* |
| Hay que restaurar la base | Que haya backups en R2 (comando de arriba) | `deploy/restaurar.sh ultimo` y después `deploy/ingesta-ahora.sh` para recuperar los días que falten |

---

## Costos por mes

| Qué | Costo |
|---|---|
| VPS (2 vCPU, 4 GB, 40 GB; tipo Hetzner CX22) | unos € 4,5 |
| Cloudflare (DNS, CDN, TLS, Tunnel, Turnstile) | gratis |
| R2: 22 backups de menos de 100 MB cada uno (cerca de 2 GB) | gratis (el plan gratis cubre 10 GB) |
| Respaldo con LLM (opcional, apagado por defecto) | cerca de USD 1 para todo el atraso; después, centavos |
| Dominio | lo que cueste el dominio que elijan (por año) |

---

## Cómo contribuir

1. Buscá algo para hacer en las **Issues** de GitHub (<https://github.com/oblitterator/monitor_licitaciones_caba/issues>) o
   proponé una nueva. Si vas a tomar una, comentalo ahí para no pisarte con nadie.
2. Hacé una rama desde `main` con un nombre claro: `git switch -c arreglo-montos-dolares`.
3. Commits chicos, con mensajes de **una sola oración** que digan qué cambia.
4. **Antes de abrir el PR, corré las pruebas** (Python y, si tocaste `web/`, las del sitio). Si cambiaste reglas del
   parser, sumá un caso de prueba con el texto real del acto.
5. Abrí el PR contra `main` contando qué cambiaste y cómo lo probaste. Otra persona del grupo lo revisa antes de
   mergear.

Nunca commitees:

- dumps de la base (`*.dump`) ni exportaciones con datos;
- secretos: `deploy/.env`, `web/.env.local`, `.dev.vars`, tokens, claves de API o cadenas de conexión con
  contraseña. Si se te escapó uno, avisá enseguida para cambiarlo: borrarlo del historial no alcanza;
- salidas de los notebooks (`nbstripout --install` una vez en el repo lo evita).
