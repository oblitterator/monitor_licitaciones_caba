#!/usr/bin/env bash
# Programador mínimo: corre un comando todos los días a una hora fija.
#   programador.sh HH:MM comando [args...]
# La hora es la local del contenedor (variable TZ). Cada paso queda en
# `docker compose logs`. Si el comando falla, se avisa y se espera al día
# siguiente: el contenedor no se cae.
set -euo pipefail

hora="${1:?uso: programador.sh HH:MM comando [args...]}"
shift
[[ $# -gt 0 ]] || { echo "programador: falta el comando" >&2; exit 2; }
if ! [[ "$hora" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; then
  echo "programador: hora inválida '$hora' (usá HH:MM, por ejemplo 07:30)" >&2
  exit 2
fi

log() { echo "[$(date '+%F %T %Z')] programador: $*"; }

log "arranca; corre '$*' todos los días a las $hora (${TZ:-UTC})"
while true; do
  ahora=$(date +%s)
  proxima=$(date -d "today $hora" +%s)
  if (( proxima <= ahora )); then
    proxima=$(date -d "tomorrow $hora" +%s)
  fi
  log "próxima corrida: $(date -d "@$proxima" '+%F %R %Z')"
  sleep $(( proxima - ahora ))
  if "$@"; then
    log "terminó bien"
  else
    log "terminó con error (código $?); se reintenta mañana"
  fi
done
