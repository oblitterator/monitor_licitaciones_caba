-- =====================================================================
-- Trazabilidad de fuentes externas (IGJ, RNS, etc.).
-- Cada archivo descargado o registrado queda con su URL, fecha, sha256 y
-- ruta local. Las tablas cargadas desde un archivo guardan archivo_id para
-- saber de qué versión salió cada fila. El archivo en sí no va al repositorio
-- (carpeta datos/); con la URL y el sha256 se puede volver a obtener y verificar.
-- =====================================================================
CREATE TABLE IF NOT EXISTS ctl.archivo_fuente (
  id                 bigserial PRIMARY KEY,
  fuente             text NOT NULL,           -- clave de monitor_licitaciones.fuentes.FUENTES
  url                text,                    -- de dónde se bajó (NULL si se registró un archivo local sin URL)
  ruta               text NOT NULL,           -- ruta local relativa a la carpeta del proyecto
  sha256             text NOT NULL,
  bytes              bigint NOT NULL,
  http_last_modified text,                    -- encabezado Last-Modified del servidor, si lo informó
  descargado_en      timestamptz NOT NULL DEFAULT now(),
  ejecucion_id       bigint REFERENCES ctl.ejecucion(id),
  filas_cargadas     bigint,                  -- lo completa el cargador correspondiente
  cargado_en         timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS archivo_fuente_sha_idx ON ctl.archivo_fuente (fuente, sha256);
