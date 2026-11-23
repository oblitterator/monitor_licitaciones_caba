#!/usr/bin/env bash
# Backup de la base con pg_dump -Fc, subido a un bucket S3 compatible (R2).
#
# Estructura en el bucket:
#   <R2_PREFIJO>/diario/boletin-AAAA-MM-DD.dump    se guardan BACKUP_DIARIOS (14)
#   <R2_PREFIJO>/semanal/boletin-AAAA-MM-DD.dump   se guardan BACKUP_SEMANALES (8)
# El semanal es una copia del diario del día BACKUP_DIA_SEMANAL (1=lunes ... 7=domingo).
#
# Conexión a Postgres: PGHOST, PGUSER, PGPASSWORD, PGDATABASE.
# Credenciales de R2: AWS_ENDPOINT_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.
set -Eeuo pipefail

log() { echo "[$(date '+%F %T')] backup: $*"; }

aviso() {
  [[ -n "${AVISO_URL_BACKUP:-}" ]] || return 0
  curl -fsS -m 10 -o /dev/null "$1" || log "no se pudo mandar el aviso"
}
trap 'aviso "${AVISO_URL_BACKUP:-}/fail"' ERR

: "${R2_BUCKET:?falta R2_BUCKET}"
: "${AWS_ENDPOINT_URL:?falta R2_ENDPOINT}"
: "${AWS_ACCESS_KEY_ID:?falta R2_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?falta R2_SECRET_ACCESS_KEY}"

prefijo="s3://${R2_BUCKET}/${R2_PREFIJO:-backups}"
aws_s3() { aws --endpoint-url "$AWS_ENDPOINT_URL" s3 "$@"; }

fecha=$(date +%F)
nombre="boletin-${fecha}.dump"
archivo="${TMPDIR:-/tmp}/${nombre}"
trap 'rm -f "$archivo"' EXIT

log "pg_dump de ${PGDATABASE} ..."
pg_dump -Fc -f "$archivo"
log "dump listo: $(du -h "$archivo" | cut -f1)"

# Chequeo rápido de que el archivo se puede leer
pg_restore -l "$archivo" >/dev/null

aws_s3 cp --only-show-errors "$archivo" "${prefijo}/diario/${nombre}"
log "subido a ${prefijo}/diario/${nombre}"

if [[ "$(date +%u)" == "${BACKUP_DIA_SEMANAL:-7}" ]]; then
  aws_s3 cp --only-show-errors "${prefijo}/diario/${nombre}" "${prefijo}/semanal/${nombre}"
  log "copia semanal en ${prefijo}/semanal/${nombre}"
fi

# Retención: se borran los más viejos de cada carpeta (los nombres ordenan por fecha)
podar() {
  local carpeta="$1" guardar="$2" viejo
  # (si la carpeta todavía no existe, ls y grep no devuelven nada: no es error)
  { aws_s3 ls "${prefijo}/${carpeta}/" || true; } | awk '{print $4}' | { grep '^boletin-.*\.dump$' || true; } \
    | sort | head -n "-${guardar}" | while read -r viejo; do
        aws_s3 rm --only-show-errors "${prefijo}/${carpeta}/${viejo}"
        log "borrado ${carpeta}/${viejo} (retención: ${guardar})"
      done
}
podar diario  "${BACKUP_DIARIOS:-14}"
podar semanal "${BACKUP_SEMANALES:-8}"

log "terminó bien"
aviso "${AVISO_URL_BACKUP:-}"
