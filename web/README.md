# Monitor de Licitaciones CABA · sitio web

Sitio público sobre las contrataciones de la Ciudad de Buenos Aires publicadas en el Boletín Oficial. Lee directo la
base PostgreSQL que arma el paquete `monitor_licitaciones` (ver el README de la raíz) y no tiene API propia: las páginas
son React Server Components que consultan Postgres.

Para correrlo, desplegarlo y colaborar: **[docs/COLABORAR.md](../docs/COLABORAR.md)**.

- Next.js 16 (App Router), TypeScript estricto, CSS plano con el sistema visual de Claude Design (`app/globals.css`).
- Driver `postgres` (postgres.js) detrás de un único módulo, `lib/db.ts`. Todo el SQL es parametrizado y de solo
  lectura, salvo los formularios, que escriben únicamente en el esquema `app`.
- Producción: servidor Node *standalone* en Docker, junto a la base (`../deploy/`). Alternativa: Cloudflare Workers
  con `@opennextjs/cloudflare`, donde la conexión pasa por Hyperdrive.
- Lecturas cacheadas una hora (`unstable_cache`, `lib/datos.ts`): los datos cambian una vez por día.
- Casi sin JavaScript en el cliente: solo los formularios (alertas, reportes) y el widget de Turnstile.

## Páginas

| Ruta | Qué muestra |
|---|---|
| `/` | Tablero: indicadores del período (`?anio=`, `?periodo=mes&mes=`, `?periodo=rango&desde=&hasta=`), último boletín por etapa, señales recientes, rankings |
| `/procesos` | Buscador con texto completo en castellano, filtros, orden y paginado en la URL |
| `/procesos/exportar` | CSV con los mismos filtros (hasta 10.000 filas) |
| `/procesos/[codigo]` | Ficha de proceso: línea de tiempo con PDF, ganadores, firmas, señales, calidad del dato y fuentes numeradas |
| `/proveedores`, `/proveedores/[cuit]` | Lista y legajo de proveedor |
| `/organismos`, `/organismos/[id]` | Lista y legajo de organismo (unidad de compras) |
| `/senales`, `/senales/[tipo]` | Señales con su metodología y casos |
| `/alertas`, `/alertas/confirmar` | Alta de alertas con doble opt-in |
| `/metodologia` | Cobertura y calidad, calculadas en vivo |
| `/sitemap.xml`, `/robots.txt` | SEO |

## Base de datos

El sitio necesita, además de los esquemas de la ingesta, los objetos de `../sql/060_web.sql`:

- `web.acto_busqueda` y `web.senal_caso`: vistas materializadas para el buscador (índice GIN sobre
  `to_tsvector('spanish', …)`) y para las señales.
- `app.alerta` y `app.reporte`: lo que escriben los formularios. `app` nunca se borra desde los scripts SQL.

`060_web.sql` corre solo con `python -m monitor_licitaciones init-db` (aplica todos los `.sql` en orden). Como `040`
recrea el esquema `analitica` con `CASCADE`, `060` vuelve a crear las vistas materializadas cada vez. **Después de cada
ingesta** hay que refrescarlas:

```sql
SELECT web.refrescar();
```

Usuario recomendado para el sitio (si existe al correr `060`, se le dan los permisos solo):

```sql
CREATE ROLE monitor_web LOGIN PASSWORD '...';   -- la contraseña no se guarda en el repo
```

Tiene lectura sobre `analitica`, `web`, `bo` y `ref`, y `INSERT`/`UPDATE` solo sobre `app.alerta` y `app.reporte`.

## Variables de entorno

| Variable | Dónde | Para qué |
|---|---|---|
| `DATABASE_URL` | `.env.local` (Node) | Conexión a Postgres en `next dev` / `next start`. En Workers no se usa. |
| `SITE_URL` | `.env.local` / `vars` de wrangler | URL pública (canonical, sitemap, Open Graph) |
| `TURNSTILE_ENABLED` | ídem | `true` para exigir Cloudflare Turnstile en los formularios. En `false` (desarrollo) no se verifica. |
| `TURNSTILE_SITE_KEY` | ídem | Clave pública del widget |
| `TURNSTILE_SECRET_KEY` | secreto (`wrangler secret put`) | Verificación del token del lado del servidor |

Plantillas: `.env.example` y `.dev.vars.example`. Nunca commitear los archivos reales.

## Desarrollo local

```bash
pnpm install
cp .env.example .env.local      # completar DATABASE_URL
pnpm dev                        # http://localhost:3000
pnpm typecheck && pnpm lint && pnpm test
```

### Restaurar el dump en un Postgres local

El dump es formato custom de `pg_dump` 16 y trae `pg_trgm`. Con un Postgres 16 normal:

```bash
createdb boletin_oficial_caba
pg_restore --no-owner -d boletin_oficial_caba monitor_licitaciones_caba.dump
# poner al día los esquemas y vistas y crear los objetos del sitio
python -m monitor_licitaciones init-db    # o psql -f ../sql/0*.sql en orden
psql -d boletin_oficial_caba -c "SELECT web.refrescar();"
```

Si el Postgres no tiene `pg_trgm` (por ejemplo el embebido de `pgserver`), crear antes del restore un reemplazo de
`similarity()` y del operador `%`, sacar la extensión de la lista del restore (`pg_restore -l | grep -v pg_trgm > lista`
y `pg_restore -L lista`) y aceptar que falle el índice `gin_trgm_ops`; al aplicar los `.sql` hay que quitar la línea
`CREATE EXTENSION pg_trgm` y las que usan `gin_trgm_ops`. El sitio no usa trigramas.

## Servidor propio (Node standalone, Docker)

Es el despliegue de producción: `../deploy/docker-compose.yml` arma la imagen con `../deploy/web/Dockerfile`.

```bash
pnpm build:node                  # NEXT_OUTPUT=standalone next build -> .next/standalone/server.js
cp -r .next/static .next/standalone/.next/static
DATABASE_URL=postgres://... PORT=3000 node .next/standalone/server.js
```

`output: "standalone"` se activa solo con `NEXT_OUTPUT=standalone`, así el build de Workers (`build:cf`) no cambia.
`/salud` responde `{"ok":true}` si el server llega a Postgres (lo usa el healthcheck de Docker).

## Cloudflare (Workers + Hyperdrive)

1. Hyperdrive, apuntando al usuario `monitor_web` (la cadena con contraseña se pasa solo por la línea de comandos o
   el panel, nunca al repo):
   ```bash
   pnpm wrangler hyperdrive create monitor-licitaciones --connection-string="postgres://monitor_web:<contraseña>@<host>:5432/<base>"
   ```
   Copiar el `id` que devuelve en `wrangler.jsonc` (`hyperdrive[0].id`, hoy `<ID_DE_HYPERDRIVE>`).
2. Bucket R2 para la caché incremental de Next:
   ```bash
   pnpm wrangler r2 bucket create monitor-licitaciones-cache
   ```
3. Variables y secretos: ajustar `vars` en `wrangler.jsonc` (`SITE_URL`, `TURNSTILE_ENABLED`, `TURNSTILE_SITE_KEY`) y
   ```bash
   pnpm wrangler secret put TURNSTILE_SECRET_KEY
   ```
4. Probar localmente el build de Workers contra una base local (la contraseña puede ser cualquiera si la base usa
   `trust`):
   ```bash
   CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://usuario:clave@127.0.0.1:5432/base" pnpm preview
   ```
5. Desplegar: `pnpm deploy`.

Scripts: `dev`, `build` (Next), `build:node` (standalone para Docker), `build:cf` (`opennextjs-cloudflare build`), `preview`, `deploy`, `cf-typegen`.

## Alertas: qué falta

El alta guarda la suscripción en `app.alerta` con `token_confirmacion` y `token_baja`, sin confirmar.
`/alertas/confirmar?token=…` la confirma. **El envío de mails no está implementado**: ver `lib/correo.ts`
(`enviarConfirmacion`), que define la interfaz y deja el TODO para elegir proveedor.

## Decisiones sobre los datos

- Montos por encima de $ 1 billón (o USD 1.000 M) se marcan "a revisar" y no se suman (`web.monto_dudoso`): son errores
  de lectura del parser.
- Los años y meses sin actos cargados se muestran rayados, nunca como cero.
- El selector de pesos constantes se oculta mientras `ref.ipc` esté vacío.
- Sin topes en `ref.umbral_procedimiento`, el posible fraccionamiento se muestra como "no calculable" con sus candidatos.
- Los valores completados por el LLM (`analitica.acto_consolidado`, `*_fuente = 'llm'`) llevan la marca "Extraído con
  IA" con la cita del PDF.
