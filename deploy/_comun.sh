#!/usr/bin/env bash
# Funciones compartidas por los scripts de deploy/. No se corre solo: lo
# incluyen primera-vez.sh, actualizar.sh, ingesta-ahora.sh y restaurar.sh.
#
# Los secretos nunca pasan por la shell del servidor: los comandos de Postgres
# corren DENTRO del contenedor db, que ya tiene las variables de deploy/.env.

# Las comillas simples son a propósito: las variables se expanden DENTRO del contenedor.
# shellcheck disable=SC2016
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC2034  # lo usa actualizar.sh
REPO_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"

log() { echo "[$(date '+%F %T')] $*"; }
morir() { echo "ERROR: $*" >&2; exit 1; }

# docker compose con el archivo y el .env de deploy/
dc() { docker compose -f "$DEPLOY_DIR/docker-compose.yml" --env-file "$DEPLOY_DIR/.env" "$@"; }

requiere_env() {
  [[ -f "$DEPLOY_DIR/.env" ]] || morir "no existe deploy/.env: copiá deploy/env.example a deploy/.env y completalo"
  command -v docker >/dev/null 2>&1 || morir "no encuentro docker"
}

# psql como superusuario, dentro del contenedor db, sobre la base del sitio
psql_db() {
  dc exec -T db sh -c 'exec psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' psql "$@"
}

# Espera hasta que Postgres acepte conexiones (máximo ~2 minutos)
esperar_db() {
  local _
  for _ in $(seq 1 60); do
    if dc exec -T db sh -c 'pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  morir "Postgres no arrancó; mirá: docker compose -f deploy/docker-compose.yml logs db"
}

# Cuenta las tablas de la ingesta (0 = base vacía)
tablas_bo() {
  psql_db -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'bo'"
}

# Restaura un dump -Fc dentro del contenedor db (se copia adentro para que
# pg_restore pueda leerlo en paralelo). Los errores menores (por ejemplo,
# "schema public already exists") no cortan: se valida después.
restaurar_dump() {
  local dump="$1"
  [[ -f "$dump" ]] || morir "no existe el archivo $dump"
  log "copiando el dump al contenedor ($(du -h "$dump" | cut -f1)) ..."
  dc cp "$dump" db:/tmp/restaurar.dump
  log "pg_restore (puede tardar varios minutos) ..."
  if ! dc exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges -j 2 /tmp/restaurar.dump'; then
    log "aviso: pg_restore informó errores (suelen ser menores); verifico los datos"
  fi
  dc exec -T db rm -f /tmp/restaurar.dump
  local normas
  normas=$(psql_db -Atc "SELECT count(*) FROM bo.norma") || morir "la restauración no dejó la tabla bo.norma"
  log "restaurado: ${normas} normas en bo.norma"
}

# Aplica sql/ en orden (init-db) y refresca las vistas del sitio
aplicar_sql_y_refrescar() {
  log "aplicando sql/ en orden (init-db) ..."
  dc run --rm --no-deps ingesta monitor-licitaciones init-db
  log "refrescando las vistas del sitio (web.refrescar) ..."
  psql_db -c "SELECT web.refrescar();"
}
