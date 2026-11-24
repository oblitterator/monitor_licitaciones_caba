# Ingesta diaria: paquete monitor_licitaciones + programador simple.
# Contexto de build: la raíz del repo. Solo entra lo que habilita
# Dockerfile.dockerignore (al lado de este archivo).
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TZ=America/Argentina/Buenos_Aires

# tzdata para la hora local; util-linux trae flock (evita dos corridas a la vez)
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata util-linux \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml ./
COPY monitor_licitaciones ./monitor_licitaciones
COPY sql ./sql
# Instalación editable: init-db busca los .sql en /app/sql, al lado del paquete.
# Va con el extra "llm" para poder usar llm-enviar si se habilita.
RUN pip install -e ".[llm]"

COPY deploy/programador.sh deploy/ingesta/corrida.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/programador.sh /usr/local/bin/corrida.sh \
 && useradd --create-home --uid 10001 ingesta
USER ingesta

# Corre corrida.sh todos los días a INGESTA_HORA (hora local, TZ)
CMD ["sh", "-c", "exec programador.sh \"${INGESTA_HORA:-07:30}\" corrida.sh"]
