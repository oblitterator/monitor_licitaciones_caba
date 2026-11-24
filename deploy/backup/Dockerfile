# Backup nocturno: pg_dump -Fc a un bucket S3 compatible (Cloudflare R2).
# Misma versión de Postgres que la base, así pg_dump/pg_restore coinciden.
# Contexto de build: la raíz del repo (ver Dockerfile.dockerignore).
FROM postgres:16-bookworm

# awscli para subir a R2; curl para el aviso opcional (healthchecks.io o similar)
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends awscli curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY deploy/programador.sh deploy/backup/backup.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/programador.sh /usr/local/bin/backup.sh

# Usuario sin privilegios (el usuario "postgres" de la imagen)
USER postgres
WORKDIR /tmp

# Corre backup.sh todos los días a BACKUP_HORA (hora local, TZ)
ENTRYPOINT []
CMD ["sh", "-c", "exec programador.sh \"${BACKUP_HORA:-03:30}\" backup.sh"]
