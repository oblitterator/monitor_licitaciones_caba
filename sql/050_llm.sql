-- =====================================================================
-- Extracciones con LLM (respaldo para actos de confianza media/baja).
-- Idempotente. Las tablas van en bo/ctl; las vistas en analitica (que
-- 040 recrea entera, por eso este archivo corre después y las vuelve a crear).
--
-- Regla de mezcla: el parser por reglas MANDA. Lo del modelo solo completa
-- campos que las reglas dejaron vacíos, solo en actos de confianza media o
-- baja, solo con valores verificados (la cita está en el texto y contiene el
-- valor) y solo si el PDF no cambió desde que se mandó. Cuando las dos
-- fuentes tienen valor y no coinciden, va a analitica.control_llm para
-- revisar a mano; no se elige automáticamente.
-- =====================================================================

-- Cada envío a la Message Batches API
CREATE TABLE IF NOT EXISTS ctl.lote_llm (
  lote_id         text PRIMARY KEY,          -- id del batch (msgbatch_...)
  modelo          text NOT NULL,
  prompt_version  text NOT NULL,
  pedidos         int NOT NULL,
  costo_usd_est   numeric,
  estado_api      text,                      -- in_progress | canceling | ended
  ejecucion_id    bigint REFERENCES ctl.ejecucion(id),
  enviado_en      timestamptz NOT NULL DEFAULT now(),
  recolectado_en  timestamptz
);

-- Una extracción por acto, modelo y versión de prompt. Nunca pisa bo.acto.
CREATE TABLE IF NOT EXISTS bo.acto_llm (
  id_norma          bigint NOT NULL REFERENCES bo.norma(id_norma),
  modelo            text NOT NULL,
  prompt_version    text NOT NULL,
  documento_sha256  text,                    -- sha256 del PDF cuando se mandó (bo.documento.sha256)
  lote_id           text REFERENCES ctl.lote_llm(lote_id),
  custom_id         text NOT NULL,
  estado            text NOT NULL CHECK (estado IN ('enviado','ok','parcial','rechazado','error')),
  -- solo valores verificados contra el texto (lo no verificado queda NULL y figura en rechazos)
  etapa             text,
  codigo_proceso    text,
  monto_total       numeric,
  moneda            text,
  firmas            jsonb NOT NULL DEFAULT '[]',   -- [{orden, nombre, rol, cuit, monto, moneda, evidencia}]
  evidencias        jsonb NOT NULL DEFAULT '{}',   -- citas de etapa / código / monto
  rechazos          text[] NOT NULL DEFAULT '{}',  -- campos que no pasaron la verificación
  respuesta         jsonb,                         -- JSON crudo del modelo
  error             text,
  tokens_entrada    int,
  tokens_salida     int,
  tokens_cache_lectura   int,
  tokens_cache_escritura int,
  enviado_en        timestamptz NOT NULL DEFAULT now(),
  recibido_en       timestamptz,
  PRIMARY KEY (id_norma, modelo, prompt_version)
);
CREATE INDEX IF NOT EXISTS acto_llm_lote_idx ON bo.acto_llm (lote_id);
CREATE INDEX IF NOT EXISTS acto_llm_estado_idx ON bo.acto_llm (estado);

-- La extracción vigente por acto: verificada, sobre el PDF actual, la más reciente.
CREATE OR REPLACE VIEW analitica.acto_llm_v AS
SELECT DISTINCT ON (l.id_norma) l.*
FROM bo.acto_llm l
JOIN bo.documento d ON d.id_norma = l.id_norma AND d.sha256 IS NOT DISTINCT FROM l.documento_sha256
WHERE l.estado IN ('ok', 'parcial')
ORDER BY l.id_norma, l.recibido_en DESC NULLS LAST, l.prompt_version DESC;

-- Firmas verificadas que propuso el modelo
CREATE OR REPLACE VIEW analitica.acto_llm_firma AS
SELECT l.id_norma, l.modelo, l.prompt_version, f.orden, f.nombre AS nombre_raw, ref.norm_nombre(f.nombre) AS nombre_norm,
       f.rol, f.cuit, f.monto, f.moneda, f.evidencia
FROM analitica.acto_llm_v l,
     jsonb_to_recordset(l.firmas) AS f(orden int, nombre text, rol text, cuit bigint, monto numeric, moneda text, evidencia text);

-- Acto con los huecos de las reglas completados por el LLM (ver regla de mezcla arriba).
-- *_fuente dice de dónde salió cada valor: 'reglas' | 'llm' | NULL (monto_origen sigue siendo el de las reglas).
CREATE OR REPLACE VIEW analitica.acto_consolidado AS
WITH x AS (
  SELECT a.*, l.etapa AS l_etapa, l.codigo_proceso AS l_codigo, l.monto_total AS l_monto, l.moneda AS l_moneda,
         l.modelo AS llm_modelo, l.prompt_version AS llm_prompt_version,
         (a.confianza IN ('media','baja') AND l.id_norma IS NOT NULL) AS usa_llm
  FROM analitica.acto_v a
  LEFT JOIN analitica.acto_llm_v l USING (id_norma)
)
SELECT id_norma, fecha_publicacion, organismo, organismo_id, nombre_norma, url_norma, boletin_numero,
       tipo_proc, uoa, anio_proc, objeto, expediente, n_ofertas, n_firmas_identificadas, unica_oferta, fracasada,
       confianza, faltantes, parser_version, monto_origen,
       CASE WHEN etapa IS NULL AND usa_llm THEN l_etapa ELSE etapa END                    AS etapa,
       CASE WHEN etapa IS NOT NULL THEN 'reglas' WHEN usa_llm AND l_etapa IS NOT NULL THEN 'llm' END AS etapa_fuente,
       CASE WHEN codigo_proceso IS NULL AND usa_llm THEN l_codigo ELSE codigo_proceso END AS codigo_proceso,
       CASE WHEN codigo_proceso IS NOT NULL THEN 'reglas' WHEN usa_llm AND l_codigo IS NOT NULL THEN 'llm' END AS codigo_fuente,
       CASE WHEN monto_total IS NULL AND usa_llm THEN l_monto ELSE monto_total END        AS monto_total,
       CASE WHEN monto_total IS NULL AND usa_llm THEN l_moneda ELSE moneda END            AS moneda,
       CASE WHEN monto_total IS NOT NULL THEN 'reglas' WHEN usa_llm AND l_monto IS NOT NULL THEN 'llm' END AS monto_fuente,
       usa_llm, llm_modelo, llm_prompt_version
FROM x;

-- Las dos fuentes tienen valor y no coinciden: revisar a mano (puede estar mal cualquiera de las dos).
CREATE OR REPLACE VIEW analitica.control_llm AS
SELECT a.id_norma, a.fecha_publicacion, a.url_norma, a.confianza, l.modelo, l.prompt_version,
       a.etapa AS etapa_reglas, l.etapa AS etapa_llm,
       a.codigo_proceso AS codigo_reglas, l.codigo_proceso AS codigo_llm,
       a.monto_total AS monto_reglas, a.moneda AS moneda_reglas, l.monto_total AS monto_llm, l.moneda AS moneda_llm,
       l.evidencias
FROM analitica.acto_v a JOIN analitica.acto_llm_v l USING (id_norma)
WHERE (a.etapa IS NOT NULL AND l.etapa IS NOT NULL AND a.etapa <> l.etapa)
   OR (a.codigo_proceso IS NOT NULL AND l.codigo_proceso IS NOT NULL AND a.codigo_proceso <> l.codigo_proceso)
   OR (a.monto_total IS NOT NULL AND l.monto_total IS NOT NULL
       AND (abs(a.monto_total - l.monto_total) > 0.01 * a.monto_total OR a.moneda IS DISTINCT FROM l.moneda));

-- Cuánto aporta el LLM: actos de confianza media/baja, cuántos tienen extracción y qué campos completó
CREATE OR REPLACE VIEW analitica.calidad_llm AS
SELECT a.confianza, a.etapa,
       count(*)                                                       AS actos,
       count(l.id_norma)                                              AS con_llm,
       count(*) FILTER (WHERE a.codigo_proceso IS NULL AND l.codigo_proceso IS NOT NULL) AS codigo_completado,
       count(*) FILTER (WHERE a.monto_total IS NULL AND l.monto_total IS NOT NULL)       AS monto_completado,
       count(*) FILTER (WHERE a.etapa IS NULL AND l.etapa IS NOT NULL)                   AS etapa_completada,
       count(*) FILTER (WHERE l.estado = 'parcial')                   AS con_rechazos
FROM analitica.acto_v a LEFT JOIN analitica.acto_llm_v l USING (id_norma)
WHERE a.confianza IN ('media','baja')
GROUP BY 1, 2;
