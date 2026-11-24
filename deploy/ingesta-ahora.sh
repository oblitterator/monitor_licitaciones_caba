#!/usr/bin/env bash
# Corre la ingesta ya, sin esperar al horario programado.
#
#   deploy/ingesta-ahora.sh                 desde el último boletín hasta hoy
#   deploy/ingesta-ahora.sh 2026-11-01      desde esa fecha hasta hoy
#   deploy/ingesta-ahora.sh 2026-11-01 2026-11-05
#
# Si ya hay una corrida en curso (la programada), no arranca otra.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_comun.sh"

requiere_env
# Sin terminal (por ejemplo desde cron) docker necesita -T
tty=()
[[ -t 0 ]] || tty=(-T)
if [[ -n "$(dc ps --status running -q ingesta)" ]]; then
  dc exec "${tty[@]}" ingesta corrida.sh "$@"
else
  log "el contenedor ingesta no está corriendo; uso uno temporal"
  dc run --rm "${tty[@]}" ingesta corrida.sh "$@"
fi
