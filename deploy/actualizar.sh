#!/usr/bin/env bash
# Actualiza el servidor a la última versión de la rama:
#   git pull + build + reinicio. Si cambió algo en sql/, además corre init-db
#   y web.refrescar() (con la web y la ingesta paradas un momento).
#
#   deploy/actualizar.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_comun.sh"

# Todo va dentro de main: así bash lee el script entero antes de que git pull
# lo pueda modificar a mitad de camino.
main() {
  requiere_env
  cd "$REPO_DIR"

  local antes despues
  antes=$(git rev-parse HEAD)
  log "git pull ..."
  git pull --ff-only
  despues=$(git rev-parse HEAD)

  if [[ "$antes" == "$despues" ]]; then
    log "no hay cambios nuevos en git; reconstruyo igual (por si cambiaron las imágenes base)"
  else
    git log --oneline "$antes..$despues"
  fi

  log "construyendo las imágenes ..."
  dc build --pull

  if ! git diff --quiet "$antes" "$despues" -- sql/; then
    log "cambió sql/: aplico init-db y refresco"
    dc up -d db
    esperar_db
    dc stop web ingesta
    aplicar_sql_y_refrescar
  fi

  log "reiniciando los servicios ..."
  dc up -d --remove-orphans
  log "borrando imágenes viejas ..."
  docker image prune -f >/dev/null
  dc ps
  log "listo"
}

main "$@"
exit
