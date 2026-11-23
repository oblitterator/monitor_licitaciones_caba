#!/usr/bin/env bash
# Corrida diaria de la ingesta, en orden:
#   1. boletines y normas nuevas de la API del Boletín Oficial
#   2. PDFs pendientes (concurrencia por defecto: 6 a la vez)
#   3. parseo de actos
#   4. resolución de CUIT
#   5. snapshot de Buenos Aires Compras (si INGESTA_BAC=1)
#   6. respaldo con LLM (solo si LLM_HABILITADO=1 y hay ANTHROPIC_API_KEY)
#   7. SELECT web.refrescar();  (vistas materializadas del sitio)
#
# Uso: corrida.sh [desde [hasta]]   (fechas AAAA-MM-DD; por defecto, desde el
# último boletín cargado hasta hoy). También se pueden pasar por
# INGESTA_DESDE / INGESTA_HASTA.
#
# Si un paso falla, se registra y se sigue con los demás; el refresco del sitio
# corre siempre. Al final sale con error si algún paso falló.
set -euo pipefail

MLC="${MLC:-monitor-licitaciones}"     # el comando del paquete
PYTHON="${PYTHON:-python}"
desde="${1:-${INGESTA_DESDE:-}}"
hasta="${2:-${INGESTA_HASTA:-$(date +%F)}}"

log() { echo "[$(date '+%F %T')] ingesta: $*"; }

# Una sola corrida a la vez (la programada y la manual comparten el candado)
if command -v flock >/dev/null 2>&1; then
  exec 9>"${TMPDIR:-/tmp}/ingesta.lock"
  if ! flock -n 9; then
    log "ya hay una corrida en curso; no hago nada"
    exit 0
  fi
fi

# SQL corto contra MLC_DSN sin depender de psql (la imagen no lo trae)
sql() {
  "$PYTHON" - "$1" <<'PY'
import sys
from monitor_licitaciones.db import conectar
conn = conectar()
with conn.cursor() as cur:
    cur.execute(sys.argv[1])
    fila = cur.fetchone() if cur.description else None
conn.commit()
if fila is not None and fila[0] not in (None, ""):
    print(fila[0])
PY
}

fallas=()
paso() {
  local nombre="$1"; shift
  local t0=$SECONDS
  log "== $nombre"
  if "$@"; then
    log "   $nombre: ok ($(( SECONDS - t0 )) s)"
  else
    log "   $nombre: FALLÓ ($(( SECONDS - t0 )) s)"
    fallas+=("$nombre")
  fi
}

aviso() {
  # Ping opcional a un monitor tipo healthchecks.io: URL si salió bien, URL/fail si no
  [[ -n "${AVISO_URL_INGESTA:-}" ]] || return 0
  "$PYTHON" -c 'import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=10)' "$1" \
    >/dev/null 2>&1 || log "no se pudo mandar el aviso"
}

if [[ -z "$desde" ]]; then
  # Día siguiente al último boletín cargado (o a la última norma, si la base
  # viene de la migración v1), mirando al menos 7 días para atrás: las fechas
  # ya consultadas no se vuelven a pedir, así que ese margen no cuesta nada y
  # recupera días que antes dieron error o todavía no estaban publicados.
  desde=$(sql "SELECT least(current_date - 7, coalesce(
                 (SELECT max(fecha) FROM ctl.fecha_consultada WHERE resultado = 'con_boletin'),
                 (SELECT max(fecha_publicacion) FROM bo.norma),
                 current_date - 8) + 1)")
fi

log "arranca: boletines del $desde al $hasta"
paso "boletines" "$MLC" -v boletines --desde "$desde" --hasta "$hasta"
paso "pdfs"      "$MLC" -v pdfs --limite "${INGESTA_LIMITE_PDFS:-2000}"
paso "parsear"   "$MLC" -v parsear
paso "resolver"  "$MLC" -v resolver

if [[ "${INGESTA_BAC:-0}" == "1" ]]; then
  paso "bac" "$MLC" -v bac
fi

if [[ "${LLM_HABILITADO:-0}" == "1" ]]; then
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    # Primero se bajan los lotes que terminaron; después se mandan los nuevos
    paso "llm-recolectar" "$MLC" -v llm-recolectar
    paso "llm-enviar"     "$MLC" -v llm-enviar --limite "${LLM_LIMITE:-500}"
  else
    log "LLM_HABILITADO=1 pero falta ANTHROPIC_API_KEY: salteo el LLM"
  fi
fi

paso "web.refrescar" sql "SELECT web.refrescar()"

if (( ${#fallas[@]} )); then
  log "terminó con fallas en: ${fallas[*]} (detalle arriba y en ctl.error)"
  aviso "${AVISO_URL_INGESTA:-}/fail"
  exit 1
fi
log "terminó bien"
aviso "${AVISO_URL_INGESTA:-}"
