-- =====================================================================
-- Objetos para el sitio público (carpeta web/).
--
-- * Esquema web: vistas materializadas de lectura para el buscador y las
--   señales. Depende de analitica, que 040 recrea entera (DROP ... CASCADE
--   también borra estas vistas), así que este archivo las vuelve a crear
--   en cada init-db. Después de cada ingesta: SELECT web.refrescar();
-- * Esquema app: lo que escribe el sitio (alertas y reportes de usuarios).
--   No depende de analitica y NUNCA se borra desde acá.
-- Idempotente: se puede correr N veces.
-- =====================================================================

-- ---------------------------------------------------------------------
-- app: escrituras del sitio
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app;

-- Suscripción a alertas con doble opt-in: se crea sin confirmar y con un token
-- de un solo uso; el mail de confirmación (todavía no implementado) lleva a
-- /alertas/confirmar?token=...
CREATE TABLE IF NOT EXISTS app.alerta (
  id                 bigserial PRIMARY KEY,
  email              text NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
  tipo               text NOT NULL CHECK (tipo IN ('palabra','organismo','proveedor','senal')),
  valor              text NOT NULL CHECK (length(valor) BETWEEN 1 AND 200),
  canal              text NOT NULL DEFAULT 'mail' CHECK (canal IN ('mail')),
  token_confirmacion text NOT NULL UNIQUE,
  token_baja         text NOT NULL UNIQUE,
  confirmada_en      timestamptz,
  baja_en            timestamptz,
  creada_en          timestamptz NOT NULL DEFAULT now(),
  actualizada_en     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS alerta_unica_idx ON app.alerta (lower(email), tipo, lower(valor));

-- Reportes de error en un dato y sugerencias de CUIT para firmas sin identificar
CREATE TABLE IF NOT EXISTS app.reporte (
  id            bigserial PRIMARY KEY,
  tipo          text NOT NULL CHECK (tipo IN ('error','cuit')),
  entidad       text NOT NULL CHECK (entidad IN ('proceso','proveedor','organismo','firma')),
  clave         text NOT NULL CHECK (length(clave) <= 200),     -- código de proceso, CUIT, id de organismo o nombre_norm
  campo         text CHECK (length(campo) <= 100),
  mensaje       text CHECK (length(mensaje) <= 4000),
  cuit_sugerido bigint,
  email         text CHECK (email IS NULL OR (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254)),
  pagina        text CHECK (length(pagina) <= 500),
  estado        text NOT NULL DEFAULT 'nuevo' CHECK (estado IN ('nuevo','revisado','aplicado','descartado')),
  creado_en     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reporte_estado_idx ON app.reporte (estado, creado_en);

-- ---------------------------------------------------------------------
-- web: vistas materializadas de lectura
-- ---------------------------------------------------------------------
DROP SCHEMA IF EXISTS web CASCADE;
CREATE SCHEMA web;

-- Un monto por encima de esto (en ARS; USD / 1000) no puede ser un contrato
-- de la Ciudad: es un error de lectura del parser. Se muestra marcado y se
-- excluye de las sumas. El presupuesto anual completo de la Ciudad está en
-- ese orden de magnitud.
CREATE FUNCTION web.monto_dudoso(m numeric, moneda text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT m IS NOT NULL AND m > CASE WHEN moneda = 'USD' THEN 1e9 ELSE 1e12 END
$$;

-- Casos de señal a nivel proceso (o grupo), con la fecha en que aparecieron.
-- 'excepcion' lista los procesos de contratación menor o directa; la
-- concentración es por organismo y año y se lee de analitica.s_concentracion.
CREATE MATERIALIZED VIEW web.senal_caso AS
WITH act AS (
  SELECT codigo_proceso,
         min(fecha_publicacion) FILTER (WHERE etapa IN ('prorroga','ampliacion','modificacion','rectificacion')) AS f_mod,
         (array_agg(id_norma ORDER BY fecha_publicacion DESC, id_norma DESC)
            FILTER (WHERE etapa IN ('adjudicacion','preadjudicacion')))[1] AS id_final,
         (array_agg(id_norma ORDER BY fecha_publicacion, id_norma)
            FILTER (WHERE etapa IN ('prorroga','ampliacion','modificacion','rectificacion')))[1] AS id_mod
  FROM analitica.acto_v WHERE codigo_proceso IS NOT NULL GROUP BY 1
)
SELECT 'oferta-unica'::text AS tipo, p.codigo_proceso, coalesce(p.fecha_adjudicacion, p.fecha_preadjudicacion, p.fecha_llamado) AS fecha,
       p.organismo_id, p.organismo, coalesce(p.monto_adjudicado, p.monto_preadjudicado) AS monto,
       coalesce(p.moneda_adjudicado, p.moneda_preadjudicado) AS moneda, NULL::bigint AS cuit, a.id_final AS id_norma,
       jsonb_build_object('n_ofertas', p.n_ofertas) AS detalle
FROM analitica.proceso p LEFT JOIN act a USING (codigo_proceso)
WHERE p.unica_oferta
UNION ALL
SELECT 'modificaciones', p.codigo_proceso, a.f_mod, p.organismo_id, p.organismo, p.monto_adjudicado, p.moneda_adjudicado,
       NULL, a.id_mod,
       jsonb_build_object('prorrogas', p.n_prorrogas, 'ampliaciones', p.n_ampliaciones, 'modificaciones', p.n_modificaciones,
                          'dias', a.f_mod - p.fecha_adjudicacion)
FROM analitica.proceso p JOIN act a USING (codigo_proceso)
WHERE p.n_prorrogas + p.n_ampliaciones + p.n_modificaciones > 0
UNION ALL
SELECT 'empresa-nueva', e.codigo_proceso, e.fecha_publicacion, p.organismo_id, e.organismo, e.monto_asignado, e.moneda,
       e.cuit, a.id_final,
       jsonb_build_object('razon_social', e.razon_social, 'dias', e.dias_desde_constitucion,
                          'constitucion', e.fecha_contrato_social)
FROM analitica.s_empresa_nueva e
LEFT JOIN analitica.proceso p USING (codigo_proceso) LEFT JOIN act a USING (codigo_proceso)
UNION ALL
SELECT 'domicilio-compartido', d.codigo_proceso, d.fecha_publicacion, p.organismo_id, d.organismo, NULL, NULL,
       d.cuit_1, NULL,
       jsonb_build_object('firma_1', d.firma_1, 'cuit_1', d.cuit_1, 'firma_2', d.firma_2, 'cuit_2', d.cuit_2,
                          'domicilio', d.domicilio)
FROM analitica.s_domicilio_compartido d LEFT JOIN analitica.proceso p USING (codigo_proceso)
UNION ALL
SELECT 'fraccionamiento', f.codigo_proceso, f.fecha, f.organismo_id, f.organismo, f.monto_asignado, 'ARS',
       f.cuit, NULL,
       jsonb_build_object('n_90d', f.n_90d, 'suma_90d', f.suma_90d, 'tope', f.monto_tope,
                          'supera_tope', f.supera_tope_acumulado, 'tipo_proc', f.tipo_proc)
FROM analitica.s_fraccionamiento f
UNION ALL
SELECT 'excepcion', p.codigo_proceso, coalesce(p.fecha_adjudicacion, p.fecha_preadjudicacion), p.organismo_id, p.organismo,
       coalesce(p.monto_adjudicado, p.monto_preadjudicado), coalesce(p.moneda_adjudicado, p.moneda_preadjudicado),
       NULL, a.id_final, jsonb_build_object('tipo_proc', p.tipo_proc)
FROM analitica.proceso p LEFT JOIN act a USING (codigo_proceso)
WHERE p.tipo_proc IN ('CME','CDI') AND coalesce(p.fecha_adjudicacion, p.fecha_preadjudicacion) IS NOT NULL;

CREATE INDEX senal_caso_tipo_idx ON web.senal_caso (tipo, fecha DESC);
CREATE INDEX senal_caso_proc_idx ON web.senal_caso (codigo_proceso);
CREATE INDEX senal_caso_org_idx  ON web.senal_caso (organismo_id);
CREATE INDEX senal_caso_cuit_idx ON web.senal_caso (cuit);

-- Una fila por acto (publicación), con las señales de su proceso y un
-- documento de búsqueda en castellano: objeto, código, expediente,
-- organismo y las firmas (nombre y CUIT) de todo el proceso.
CREATE MATERIALIZED VIEW web.acto_busqueda AS
WITH firmas_proc AS (
  SELECT a.codigo_proceso,
         string_agg(DISTINCT af.nombre_raw, ' ')                     AS nombres,
         string_agg(DISTINCT coalesce(e.razon_social, ''), ' ')      AS razones,
         array_agg(DISTINCT af.cuit) FILTER (WHERE af.cuit IS NOT NULL) AS cuits
  FROM bo.acto_firma af JOIN analitica.acto_consolidado a USING (id_norma)
  LEFT JOIN ref.empresa e ON e.cuit = af.cuit
  WHERE a.codigo_proceso IS NOT NULL
  GROUP BY 1
), firmas_acto AS (
  SELECT af.id_norma, string_agg(af.nombre_raw, ' ') AS nombres,
         array_agg(af.cuit) FILTER (WHERE af.cuit IS NOT NULL) AS cuits
  FROM bo.acto_firma af GROUP BY 1
), sen AS (
  SELECT codigo_proceso, array_agg(DISTINCT tipo ORDER BY tipo) AS senales
  FROM web.senal_caso WHERE tipo NOT IN ('excepcion') GROUP BY 1
)
SELECT a.id_norma, a.codigo_proceso, a.codigo_fuente, a.fecha_publicacion, a.etapa, a.etapa_fuente,
       a.tipo_proc, a.organismo, a.organismo_id, coalesce(a.objeto, p.objeto) AS objeto, a.expediente,
       a.monto_total, a.moneda, a.monto_origen, a.monto_fuente, web.monto_dudoso(a.monto_total, a.moneda) AS monto_dudoso,
       a.confianza, a.url_norma, a.nombre_norma, a.n_ofertas, a.unica_oferta,
       coalesce(s.senales, '{}') AS senales,
       coalesce(fp.cuits, fa.cuits, '{}') AS cuits,
       setweight(to_tsvector('spanish', coalesce(a.objeto, p.objeto, '')), 'A') ||
       setweight(to_tsvector('simple', coalesce(a.codigo_proceso, '') || ' ' || coalesce(a.expediente, '')), 'A') ||
       setweight(to_tsvector('spanish', coalesce(fp.nombres, fa.nombres, '') || ' ' || coalesce(fp.razones, '')), 'B') ||
       setweight(to_tsvector('spanish', coalesce(a.organismo, '') || ' ' || coalesce(a.nombre_norma, '')), 'C') AS doc
FROM analitica.acto_consolidado a
LEFT JOIN analitica.proceso p ON p.codigo_proceso = a.codigo_proceso
LEFT JOIN firmas_proc fp ON fp.codigo_proceso = a.codigo_proceso
LEFT JOIN firmas_acto fa ON fa.id_norma = a.id_norma
LEFT JOIN sen s ON s.codigo_proceso = a.codigo_proceso;

CREATE UNIQUE INDEX acto_busqueda_pk     ON web.acto_busqueda (id_norma);
CREATE INDEX acto_busqueda_doc_idx       ON web.acto_busqueda USING gin (doc);
CREATE INDEX acto_busqueda_cuits_idx     ON web.acto_busqueda USING gin (cuits);
CREATE INDEX acto_busqueda_fecha_idx     ON web.acto_busqueda (fecha_publicacion DESC, id_norma DESC);
CREATE INDEX acto_busqueda_proc_idx      ON web.acto_busqueda (codigo_proceso);
CREATE INDEX acto_busqueda_org_idx       ON web.acto_busqueda (organismo_id);

-- Refresco después de cada ingesta (lo puede correr el usuario de la ingesta)
CREATE FUNCTION web.refrescar() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW web.senal_caso;
  REFRESH MATERIALIZED VIEW web.acto_busqueda;
END $$;

-- Permisos para el usuario del sitio, si existe (ver web/README.md):
-- lectura en todo lo analítico, escritura solo en app.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'monitor_web') THEN
    GRANT USAGE ON SCHEMA analitica, web, bo, ref, app TO monitor_web;
    GRANT SELECT ON ALL TABLES IN SCHEMA analitica, web, bo, ref TO monitor_web;
    GRANT SELECT, INSERT, UPDATE ON app.alerta, app.reporte TO monitor_web;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA app TO monitor_web;
  END IF;
END $$;
