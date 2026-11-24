#!/usr/bin/env bash
# Puesta en marcha en un servidor nuevo.
#
#   deploy/primera-vez.sh [archivo.dump]
#
# 1. construye las imágenes y levanta Postgres
# 2. crea la base si no existe
# 3. si le pasás un dump (pg_dump -Fc), lo restaura (solo sobre una base vacía)
# 4. crea o actualiza el usuario de solo lectura monitor_web (clave: MONITOR_WEB_PASSWORD)
# 5. aplica sql/ en orden (init-db), que también le da los permisos a monitor_web
# 6. corre SELECT web.refrescar();
# 7. levanta todo (web, ingesta, backup, cloudflared)
#
# Se puede volver a correr: cada paso es idempotente.
# Las comillas simples son a propósito: las variables se expanden DENTRO del contenedor.
# shellcheck disable=SC2016
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_comun.sh"

dump="${1:-}"
requiere_env

log "construyendo las imágenes ..."
dc build

log "levantando Postgres ..."
dc up -d db
esperar_db

# La imagen crea POSTGRES_DB cuando el volumen está vacío; por las dudas:
dc exec -T db sh -c '
  psql -X -U "$POSTGRES_USER" -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '\''$POSTGRES_DB'\''" | grep -q 1 \
    || createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'

if [[ -n "$dump" ]]; then
  if [[ "$(tablas_bo)" != "0" && "${FORZAR:-0}" != "1" ]]; then
    morir "la base ya tiene datos; para pisarla usá deploy/restaurar.sh $dump"
  fi
  restaurar_dump "$dump"
fi

log "creando/actualizando el usuario monitor_web ..."
# \getenv lee la clave del entorno del contenedor: nunca aparece en pantalla ni en la línea de comandos
psql_db <<'SQL'
\getenv clave MONITOR_WEB_PASSWORD
SELECT 'CREATE ROLE monitor_web LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'monitor_web') \gexec
ALTER ROLE monitor_web WITH LOGIN PASSWORD :'clave';
SQL

aplicar_sql_y_refrescar

log "levantando todos los servicios ..."
dc up -d
dc ps
log "listo. Probá: curl -s http://127.0.0.1:3000/salud"
