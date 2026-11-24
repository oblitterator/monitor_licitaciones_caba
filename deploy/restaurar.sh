#!/usr/bin/env bash
# Restaura la base desde un backup. BORRA la base actual.
#
#   deploy/restaurar.sh archivo.dump              un dump local (pg_dump -Fc)
#   deploy/restaurar.sh ultimo                    el último backup diario de R2
#   deploy/restaurar.sh diario/boletin-2026-11-20.dump    uno puntual de R2
#                                                 (ruta dentro de R2_PREFIJO)
#
# Pide confirmación; con SI=1 no pregunta.
# Las comillas simples son a propósito: las variables se expanden DENTRO del contenedor.
# shellcheck disable=SC2016
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_comun.sh"

origen="${1:?uso: deploy/restaurar.sh archivo.dump | ultimo | diario/boletin-AAAA-MM-DD.dump}"
requiere_env

# aws dentro del contenedor backup (ahí están las credenciales de R2)
r2() { dc run --rm --no-deps -T backup sh -c "$1" sh "${@:2}"; }

tmp=""
trap '[[ -n "$tmp" ]] && rm -f "$tmp"' EXIT

if [[ -f "$origen" ]]; then
  dump="$origen"
else
  clave="$origen"
  if [[ "$origen" == "ultimo" ]]; then
    clave=$(r2 'aws --endpoint-url "$AWS_ENDPOINT_URL" s3 ls "s3://$R2_BUCKET/${R2_PREFIJO:-backups}/diario/"' \
            | awk '{print $4}' | grep '^boletin-.*\.dump$' | sort | tail -n 1) || true
    [[ -n "$clave" ]] || morir "no encontré backups en R2"
    clave="diario/$clave"
  fi
  tmp="$(mktemp "${TMPDIR:-/tmp}/restaurar.XXXXXX")"
  log "bajando $clave de R2 ..."
  r2 'aws --endpoint-url "$AWS_ENDPOINT_URL" s3 cp --only-show-errors "s3://$R2_BUCKET/${R2_PREFIJO:-backups}/$1" -' "$clave" > "$tmp"
  dump="$tmp"
fi

if [[ "${SI:-0}" != "1" ]]; then
  read -r -p "Esto BORRA la base actual y la reemplaza por $origen. Escribí 'si' para seguir: " resp
  [[ "$resp" == "si" ]] || morir "cancelado"
fi

log "parando web, ingesta y backup ..."
dc stop web ingesta backup
dc up -d db
esperar_db

log "borrando y recreando la base ..."
dc exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --force --if-exists "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'

restaurar_dump "$dump"
# init-db deja todo al día y vuelve a dar los permisos a monitor_web
aplicar_sql_y_refrescar

log "levantando todo ..."
dc up -d
log "listo"
