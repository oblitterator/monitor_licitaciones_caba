-- =====================================================================
-- Vistas analíticas y SEÑALES.
-- Las señales son indicadores para priorizar revisión, NO prueban irregularidad.
-- El esquema analitica se recrea entero en cada init-db: NO guardar objetos
-- propios ahí (usar otro esquema para vistas personales).
-- =====================================================================
DROP SCHEMA IF EXISTS analitica CASCADE;
CREATE SCHEMA analitica;

-- Acto + datos de la norma
CREATE VIEW analitica.acto_v AS
-- organismo_id = unidad emisora (SIGLA@entidad); jurisdicción y poder salen de la entidad publicada.
SELECT a.*, n.fecha_publicacion, coalesce(u.organismo, n.organismo) AS organismo, n.seccion, n.tipo AS tipo_norma,
       n.nombre AS nombre_norma, n.url_norma, n.boletin_numero,
       k.clave AS organismo_id,
       coalesce(u.jurisdiccion, ref.jurisdiccion_de(n.organismo), '(sin jurisdicción)') AS jurisdiccion,
       coalesce(u.poder, ref.poder_de(n.organismo), '(sin dato)') AS poder,
       u.tipo_unidad, u.sigla AS sigla_unidad, u.organismo AS unidad
FROM bo.acto a JOIN bo.norma n USING (id_norma)
LEFT JOIN ref.norma_unidad nu ON nu.id_norma = a.id_norma
-- si la norma todavía no pasó por ref.actualizar_unidades() se calcula al vuelo (coalesce no evalúa de más)
CROSS JOIN LATERAL (SELECT coalesce(nu.clave, ref.clave_unidad(n.organismo, ref.sigla_de_nombre(n.nombre))) AS clave) k
LEFT JOIN ref.unidad u ON u.clave = k.clave;

-- Factor para pasar pesos corrientes a pesos del último mes con IPC cargado
CREATE VIEW analitica.ipc_factor AS
SELECT i.mes, (SELECT indice FROM ref.ipc ORDER BY mes DESC LIMIT 1) / i.indice AS factor
FROM ref.ipc i;

-- ---------------------------------------------------------------------
-- Un registro por proceso de compra (código BAC o SIGAF)
-- ---------------------------------------------------------------------
CREATE VIEW analitica.proceso AS
WITH a AS (SELECT * FROM analitica.acto_v WHERE codigo_proceso IS NOT NULL)
SELECT
  codigo_proceso,
  max(uoa)                                   AS uoa,
  max(tipo_proc)                             AS tipo_proc,
  max(anio_proc)                             AS anio_proc,
  mode() WITHIN GROUP (ORDER BY organismo)   AS organismo,
  mode() WITHIN GROUP (ORDER BY organismo_id) AS organismo_id,
  mode() WITHIN GROUP (ORDER BY jurisdiccion) AS jurisdiccion,
  mode() WITHIN GROUP (ORDER BY poder)        AS poder,
  (array_agg(objeto ORDER BY fecha_publicacion) FILTER (WHERE objeto IS NOT NULL))[1] AS objeto,
  mode() WITHIN GROUP (ORDER BY categoria)    AS categoria,
  mode() WITHIN GROUP (ORDER BY subcategoria) AS subcategoria,
  bool_or(datos_paciente)                    AS datos_paciente,
  min(fecha_publicacion) FILTER (WHERE etapa = 'llamado')          AS fecha_llamado,
  max(fecha_publicacion) FILTER (WHERE etapa = 'preadjudicacion')  AS fecha_preadjudicacion,
  max(fecha_publicacion) FILTER (WHERE etapa = 'adjudicacion')     AS fecha_adjudicacion,
  (array_agg(monto_total ORDER BY fecha_publicacion DESC, id_norma DESC)
     FILTER (WHERE etapa = 'adjudicacion' AND monto_total IS NOT NULL))[1]    AS monto_adjudicado,
  (array_agg(moneda ORDER BY fecha_publicacion DESC, id_norma DESC)
     FILTER (WHERE etapa = 'adjudicacion' AND monto_total IS NOT NULL))[1]    AS moneda_adjudicado,
  (array_agg(monto_total ORDER BY fecha_publicacion DESC, id_norma DESC)
     FILTER (WHERE etapa = 'preadjudicacion' AND monto_total IS NOT NULL))[1] AS monto_preadjudicado,
  (array_agg(moneda ORDER BY fecha_publicacion DESC, id_norma DESC)
     FILTER (WHERE etapa = 'preadjudicacion' AND monto_total IS NOT NULL))[1] AS moneda_preadjudicado,
  max(n_ofertas)                             AS n_ofertas,
  max(n_firmas_identificadas)                AS n_firmas_identificadas,
  bool_or(unica_oferta)                      AS unica_oferta,
  bool_or(fracasada)                         AS fracasada,
  count(*) FILTER (WHERE etapa = 'prorroga')                 AS n_prorrogas,
  count(*) FILTER (WHERE etapa = 'ampliacion')               AS n_ampliaciones,
  count(*) FILTER (WHERE etapa LIKE 'circular%')             AS n_circulares,
  count(*) FILTER (WHERE etapa IN ('modificacion','rectificacion')) AS n_modificaciones,
  count(*)                                   AS n_actos
FROM a
GROUP BY codigo_proceso;

-- ---------------------------------------------------------------------
-- Ganadores por proceso, tomados del acto final (adjudicación; si no hay,
-- preadjudicación). El monto se asigna a la firma SOLO si es inequívoco:
-- una sola ganadora, o el texto da el monto de esa firma. Nunca se duplica.
-- ---------------------------------------------------------------------
CREATE VIEW analitica.ganador AS
WITH final AS (
  SELECT DISTINCT ON (codigo_proceso)
         codigo_proceso, id_norma, etapa, fecha_publicacion, monto_total, moneda, organismo, organismo_id,
         tipo_proc, uoa, jurisdiccion, poder, tipo_unidad
  FROM analitica.acto_v
  WHERE codigo_proceso IS NOT NULL AND etapa IN ('adjudicacion','preadjudicacion') AND NOT fracasada
  ORDER BY codigo_proceso, (etapa = 'adjudicacion') DESC, fecha_publicacion DESC, id_norma DESC
), g AS (
  SELECT f.*, af.orden, af.nombre_raw, af.nombre_norm, af.cuit, af.resolucion, af.score,
         af.monto AS monto_firma,
         count(*) OVER (PARTITION BY f.id_norma) AS n_ganadoras
  FROM final f
  JOIN bo.acto_firma af ON af.id_norma = f.id_norma AND af.rol IN ('adjudicada','preadjudicada')
), m AS MATERIALIZED (
  SELECT g.*, CASE WHEN n_ganadoras = 1 THEN monto_total ELSE monto_firma END AS monto_bruto,
         sum(monto_firma) OVER (PARTITION BY id_norma) AS suma_firmas,
         count(monto_firma) OVER (PARTITION BY id_norma) AS firmas_con_monto,
         extract(year FROM fecha_publicacion)::int AS anio
  FROM g
), tope AS MATERIALIZED (   -- percentil 99 por tipo de procedimiento y año (MATERIALIZED: se calcula una sola vez)
  SELECT tipo_proc, anio, percentile_cont(0.99) WITHIN GROUP (ORDER BY monto_bruto) AS p99
  FROM m WHERE moneda = 'ARS' AND monto_bruto > 0 GROUP BY 1, 2
), r AS (
  SELECT m.*,
         CASE
           WHEN m.monto_bruto IS NULL THEN NULL
           WHEN m.monto_bruto <= 0 THEN 'monto no positivo'
           WHEN m.monto_total > 0 AND m.monto_firma > m.monto_total * 1.05 THEN 'la firma supera el total del acto'
           WHEN m.monto_total > 0 AND m.firmas_con_monto = m.n_ganadoras AND m.n_ganadoras > 1
                AND (m.suma_firmas / m.monto_total >= 20 OR m.monto_total / nullif(m.suma_firmas, 0) >= 20)
                THEN 'total y suma por firma no coinciden (x20 o más)'
           WHEN m.tipo_proc = 'CME' AND m.monto_bruto > 3 * t.p99
                THEN 'supera por mucho lo habitual en contratación menor'
         END AS monto_revision
  FROM m LEFT JOIN tope t USING (tipo_proc, anio)
)
-- monto_asignado excluye los montos dudosos (quedan en monto_original con el motivo en monto_revision)
SELECT r.codigo_proceso, r.id_norma, r.etapa, r.fecha_publicacion, r.monto_total, r.moneda, r.organismo, r.organismo_id,
       r.tipo_proc, r.uoa, r.jurisdiccion, r.poder, r.tipo_unidad, r.orden, r.nombre_raw, r.nombre_norm, r.cuit,
       r.resolucion, r.score, r.monto_firma, r.n_ganadoras,
       pc.categoria, pc.subcategoria, pc.objeto,
       CASE WHEN r.monto_revision IS NULL THEN r.monto_bruto END AS monto_asignado,
       r.monto_bruto AS monto_original, r.monto_revision,
       (r.n_ganadoras > 1 AND r.monto_firma IS NULL)                          AS monto_no_asignable,
       CASE WHEN r.moneda = 'ARS' AND r.monto_revision IS NULL THEN r.monto_bruto * fx.factor END AS monto_constante,
       r.anio
FROM r
LEFT JOIN analitica.ipc_factor fx ON fx.mes = date_trunc('month', r.fecha_publicacion)::date
LEFT JOIN LATERAL (
  -- categoría a nivel proceso: la más frecuente entre sus actos (el acto final puede no traer objeto)
  SELECT mode() WITHIN GROUP (ORDER BY a.categoria)    AS categoria,
         mode() WITHIN GROUP (ORDER BY a.subcategoria) AS subcategoria,
         (array_agg(a.objeto ORDER BY a.id_norma) FILTER (WHERE a.objeto IS NOT NULL))[1] AS objeto
  FROM bo.acto a WHERE a.codigo_proceso = r.codigo_proceso
) pc ON true;

-- =====================================================================
-- SEÑALES
-- =====================================================================

-- 1) Competencia: procesos con oferta única, por organismo y año
CREATE VIEW analitica.s_competencia AS
SELECT organismo_id, mode() WITHIN GROUP (ORDER BY organismo) AS organismo,
       extract(year FROM coalesce(fecha_adjudicacion, fecha_preadjudicacion))::int AS anio,
       count(*)                                              AS procesos,
       count(*) FILTER (WHERE unica_oferta IS NOT NULL)      AS procesos_con_dato,
       count(*) FILTER (WHERE unica_oferta)                  AS oferta_unica,
       round(100.0 * count(*) FILTER (WHERE unica_oferta)
             / nullif(count(*) FILTER (WHERE unica_oferta IS NOT NULL), 0), 1) AS pct_oferta_unica,
       round(avg(n_ofertas), 2)                              AS promedio_ofertas
FROM analitica.proceso
WHERE coalesce(fecha_adjudicacion, fecha_preadjudicacion) IS NOT NULL
GROUP BY 1, 3;

-- 2) Concentración de proveedores (HHI 0–10.000) por organismo y año.
--    Usa pesos constantes si hay IPC; si no, nominales.
CREATE VIEW analitica.s_concentracion AS
WITH base AS (
  SELECT organismo_id, organismo, anio, cuit,
         sum(coalesce(monto_constante, monto_asignado)) AS monto
  FROM analitica.ganador
  WHERE cuit IS NOT NULL AND moneda = 'ARS' AND monto_asignado IS NOT NULL
  GROUP BY 1, 2, 3, 4
), tot AS (
  SELECT organismo_id, anio, sum(monto) AS total, count(*) AS proveedores FROM base GROUP BY 1, 2
), sh AS (
  SELECT b.*, t.total, t.proveedores, b.monto / nullif(t.total, 0) AS share,
         row_number() OVER (PARTITION BY b.organismo_id, b.anio ORDER BY b.monto DESC) AS rk
  FROM base b JOIN tot t USING (organismo_id, anio)
)
SELECT organismo_id, max(organismo) AS organismo, anio, max(total) AS monto_total, max(proveedores) AS proveedores,
       round(sum(share * share) * 10000) AS hhi,
       max(cuit) FILTER (WHERE rk = 1)   AS cuit_principal,
       round(100 * max(share) , 1)       AS pct_principal,
       (SELECT count(*) FROM ref.ipc) > 0 AS en_pesos_constantes
FROM sh GROUP BY organismo_id, anio;

-- 3) Uso de procedimientos de excepción (contratación menor y directa)
CREATE VIEW analitica.s_procedimiento AS
SELECT p.organismo_id, mode() WITHIN GROUP (ORDER BY p.organismo) AS organismo,
       extract(year FROM coalesce(p.fecha_adjudicacion, p.fecha_preadjudicacion))::int AS anio,
       count(*) AS procesos,
       count(*) FILTER (WHERE p.tipo_proc = 'CDI') AS directas,
       count(*) FILTER (WHERE p.tipo_proc = 'CME') AS menores,
       round(100.0 * count(*) FILTER (WHERE p.tipo_proc IN ('CDI','CME')) / count(*), 1) AS pct_excepcion_cantidad,
       round(100.0 * sum(coalesce(p.monto_adjudicado, p.monto_preadjudicado)) FILTER (WHERE p.tipo_proc IN ('CDI','CME'))
             / nullif(sum(coalesce(p.monto_adjudicado, p.monto_preadjudicado)), 0), 1) AS pct_excepcion_monto_nominal
FROM analitica.proceso p
WHERE coalesce(p.fecha_adjudicacion, p.fecha_preadjudicacion) IS NOT NULL
GROUP BY 1, 3;

-- 4) Posible fraccionamiento: 3+ contrataciones menores/directas al mismo proveedor,
--    en el mismo organismo, dentro de 90 días. Si hay topes cargados en
--    ref.umbral_procedimiento, marca cuando la suma supera el tope y cada una no.
CREATE VIEW analitica.s_fraccionamiento AS
WITH g AS (
  SELECT organismo_id, organismo, cuit, codigo_proceso, tipo_proc, fecha_publicacion::date AS fecha, monto_asignado
  FROM analitica.ganador
  WHERE tipo_proc IN ('CME','CDI') AND cuit IS NOT NULL AND moneda = 'ARS'
), w AS (
  SELECT g.*,
         count(*)            OVER v AS n_90d,
         sum(monto_asignado) OVER v AS suma_90d,
         max(monto_asignado) OVER v AS max_90d
  FROM g
  WINDOW v AS (PARTITION BY organismo_id, cuit ORDER BY fecha RANGE BETWEEN INTERVAL '90 days' PRECEDING AND CURRENT ROW)
)
SELECT w.*, u.monto_tope,
       (u.monto_tope IS NOT NULL AND w.suma_90d > u.monto_tope AND w.max_90d <= u.monto_tope) AS supera_tope_acumulado
FROM w
LEFT JOIN LATERAL (
  SELECT monto_tope FROM ref.umbral_procedimiento r
  WHERE r.tipo_proc = w.tipo_proc AND r.vigente_desde <= w.fecha
  ORDER BY r.vigente_desde DESC LIMIT 1
) u ON true
WHERE w.n_90d >= 3;

-- 5) Empresas recién constituidas al ganar (< 365 días desde el contrato social)
CREATE VIEW analitica.s_empresa_nueva AS
SELECT g.codigo_proceso, g.organismo, g.fecha_publicacion, g.cuit, e.razon_social, e.tipo_societario,
       e.fecha_contrato_social, (g.fecha_publicacion - e.fecha_contrato_social) AS dias_desde_constitucion,
       g.monto_asignado, g.moneda
FROM analitica.ganador g JOIN ref.empresa e ON e.cuit = g.cuit
WHERE e.fecha_contrato_social IS NOT NULL
  AND g.fecha_publicacion - e.fecha_contrato_social BETWEEN 0 AND 364;

-- 6) Firmas distintas con el mismo domicilio fiscal que aparecen en el mismo acto
--    (como oferentes, desestimadas o ganadoras). Señal clásica de colusión.
CREATE VIEW analitica.s_domicilio_compartido AS
SELECT a.codigo_proceso, a.organismo, a.fecha_publicacion,
       x.cuit AS cuit_1, ex.razon_social AS firma_1, x.rol AS rol_1,
       y.cuit AS cuit_2, ey.razon_social AS firma_2, y.rol AS rol_2,
       ex.dom_fiscal AS domicilio
FROM bo.acto_firma x
JOIN bo.acto_firma y ON y.id_norma = x.id_norma AND x.cuit < y.cuit
JOIN ref.empresa ex ON ex.cuit = x.cuit
JOIN ref.empresa ey ON ey.cuit = y.cuit
JOIN analitica.acto_v a ON a.id_norma = x.id_norma
WHERE ex.dom_fiscal_norm IS NOT NULL AND length(ex.dom_fiscal_norm) >= 8
  AND ex.dom_fiscal_norm = ey.dom_fiscal_norm;

-- 7) Procesos con prórrogas, ampliaciones o modificaciones posteriores
CREATE VIEW analitica.s_modificaciones AS
SELECT codigo_proceso, organismo, tipo_proc, objeto, fecha_adjudicacion, monto_adjudicado, moneda_adjudicado,
       n_prorrogas, n_ampliaciones, n_modificaciones, n_circulares
FROM analitica.proceso
WHERE n_prorrogas + n_ampliaciones + n_modificaciones > 0;

-- ---------------------------------------------------------------------
-- Resumen por proveedor (para el tablero)
-- ---------------------------------------------------------------------
CREATE VIEW analitica.proveedor AS
SELECT g.cuit, e.razon_social, e.tipo_societario, e.fecha_contrato_social,
       count(DISTINCT g.codigo_proceso)                         AS procesos_ganados,
       count(DISTINCT g.organismo_id)                           AS organismos,
       sum(g.monto_asignado)    FILTER (WHERE g.moneda = 'ARS') AS monto_nominal_ars,
       sum(g.monto_constante)                                   AS monto_constante_ars,
       count(*) FILTER (WHERE g.monto_no_asignable)             AS procesos_monto_no_asignable,
       round(100.0 * count(*) FILTER (WHERE p.unica_oferta)
             / nullif(count(*) FILTER (WHERE p.unica_oferta IS NOT NULL), 0), 1) AS pct_oferta_unica,
       round(100.0 * count(*) FILTER (WHERE g.tipo_proc IN ('CDI','CME')) / count(*), 1) AS pct_excepcion,
       min(g.fecha_publicacion) AS primera, max(g.fecha_publicacion) AS ultima
FROM analitica.ganador g
LEFT JOIN ref.empresa e ON e.cuit = g.cuit
LEFT JOIN analitica.proceso p ON p.codigo_proceso = g.codigo_proceso
WHERE g.cuit IS NOT NULL
GROUP BY g.cuit, e.razon_social, e.tipo_societario, e.fecha_contrato_social;

-- ---------------------------------------------------------------------
-- Calidad de la extracción (mirar ANTES de confiar en las señales)
-- ---------------------------------------------------------------------
CREATE VIEW analitica.calidad_parser AS
SELECT extract(year FROM fecha_publicacion)::int AS anio, etapa,
       count(*) AS actos,
       round(100.0 * count(*) FILTER (WHERE confianza = 'alta')  / count(*), 1) AS pct_alta,
       round(100.0 * count(*) FILTER (WHERE confianza = 'baja')  / count(*), 1) AS pct_baja,
       round(100.0 * count(*) FILTER (WHERE codigo_proceso IS NOT NULL) / count(*), 1) AS pct_con_codigo,
       round(100.0 * count(*) FILTER (WHERE monto_total IS NOT NULL)    / count(*), 1) AS pct_con_monto,
       round(100.0 * count(*) FILTER (WHERE etapa_conflicto)            / count(*), 1) AS pct_etapa_conflicto
FROM analitica.acto_v
GROUP BY 1, 2;

CREATE VIEW analitica.calidad_resolucion AS
SELECT rol, coalesce(resolucion, 'sin_correr') AS resolucion, count(*) AS firmas,
       round(100.0 * count(*) / sum(count(*)) OVER (PARTITION BY rol), 1) AS pct_del_rol
FROM bo.acto_firma GROUP BY 1, 2;

CREATE VIEW analitica.calidad_documentos AS
SELECT d.estado, extract(year FROM n.fecha_publicacion)::int AS anio, count(*) AS documentos,
       count(*) FILTER (WHERE d.intentos >= 3) AS agotaron_reintentos
FROM bo.documento d JOIN bo.norma n USING (id_norma) GROUP BY 1, 2;

-- Actos donde la suma de montos por firma no coincide con el total declarado
-- (errores de tipeo del propio Boletín o del parser: revisar a mano)
CREATE VIEW analitica.control_montos AS
SELECT a.id_norma, a.codigo_proceso, a.etapa, a.fecha_publicacion, a.url_norma, a.monto_total,
       sum(af.monto) AS suma_firmas, count(af.monto) AS firmas_con_monto,
       round(100 * (sum(af.monto) - a.monto_total) / nullif(a.monto_total, 0), 2) AS pct_diferencia
FROM analitica.acto_v a
JOIN bo.acto_firma af ON af.id_norma = a.id_norma AND af.rol IN ('adjudicada','preadjudicada')
WHERE a.monto_total IS NOT NULL
GROUP BY a.id_norma, a.codigo_proceso, a.etapa, a.fecha_publicacion, a.url_norma, a.monto_total
HAVING count(af.monto) = count(*) AND count(*) > 1
   AND abs(sum(af.monto) - a.monto_total) > 0.01 * a.monto_total;

-- Firmas ganadoras sin CUIT, ordenadas por impacto. Los candidatos del padrón NO se calculan acá
-- (serían miles de búsquedas sobre 1,15M de empresas): usar ref.candidatos_cuit() sobre las filas a mostrar.
-- Para resolver: INSERT INTO ref.empresa_alias (nombre_norm, cuit, fuente) VALUES ('<nombre_norm>', <cuit>, 'manual');
CREATE VIEW analitica.pendientes_cuit AS
SELECT af.nombre_norm, min(af.nombre_raw) AS ejemplo, count(*) AS actos,
       count(DISTINCT a.organismo_id) AS organismos,
       sum(coalesce(af.monto, CASE WHEN a.n_firmas_identificadas = 1 THEN a.monto_total END)) AS monto_aprox,
       max(a.fecha_publicacion) AS ultima
FROM bo.acto_firma af JOIN analitica.acto_v a USING (id_norma)
WHERE af.resolucion = 'sin_resolver' AND af.rol IN ('adjudicada','preadjudicada') AND af.nombre_norm IS NOT NULL
GROUP BY af.nombre_norm;

-- Hasta 5 candidatos del padrón para un nombre (usar solo sobre pocas filas)
CREATE OR REPLACE FUNCTION ref.candidatos_cuit(p_nombre text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT string_agg(e.cuit || ' ' || e.razon_social || coalesce(' (' || e.fecha_contrato_social || ')', ''), ' | '
                    ORDER BY e.sim DESC)
  FROM (SELECT cuit, razon_social, fecha_contrato_social, similarity(nombre_norm, ref.norm_nombre(p_nombre)) AS sim
        FROM ref.empresa
        WHERE nombre_base = ref.norm_nombre_base(p_nombre) OR nombre_norm % ref.norm_nombre(p_nombre)
        ORDER BY sim DESC LIMIT 5) e
$$;

-- ---------------------------------------------------------------------
-- Qué se compra: monto por categoría, organismo, proveedor y año.
-- Una fila por (proceso, ganador) con su categoría; agregar en la consulta.
-- ---------------------------------------------------------------------
CREATE VIEW analitica.gasto_categoria AS
SELECT g.anio, g.poder, g.jurisdiccion, g.tipo_unidad, g.organismo_id, g.organismo, g.cuit, coalesce(e.razon_social, g.nombre_norm) AS proveedor,
       coalesce(g.categoria, '(sin clasificar)') AS categoria,
       coalesce(g.subcategoria, '') AS subcategoria,
       g.tipo_proc, g.codigo_proceso, g.objeto,
       g.monto_asignado, g.monto_constante, g.moneda, g.monto_no_asignable
FROM analitica.ganador g
LEFT JOIN ref.empresa e ON e.cuit = g.cuit;

-- ---------------------------------------------------------------------
-- Cumplimiento: actos que publican nombres de pacientes junto con la
-- prestación o insumo (dato de salud = dato sensible). Los nombres ya están
-- enmascarados en bo.acto.objeto; acá NO se muestran, solo se lista el acto
-- para poder reportarlo. bo.documento.texto conserva el texto original.
-- ---------------------------------------------------------------------
CREATE VIEW analitica.control_datos_personales AS
SELECT a.id_norma, a.fecha_publicacion, a.jurisdiccion, a.organismo, a.codigo_proceso, a.etapa,
       a.categoria, a.subcategoria, a.objeto AS objeto_enmascarado,
       a.n_menciones_paciente, a.url_norma
FROM analitica.acto_v a
WHERE a.datos_paciente;

CREATE VIEW analitica.calidad_clasificacion AS
SELECT extract(year FROM fecha_publicacion)::int AS anio,
       coalesce(categoria, '(sin clasificar)') AS categoria,
       count(*) AS actos,
       count(*) FILTER (WHERE categoria_fuente = 'rubro') AS por_rubro,
       count(*) FILTER (WHERE subcategoria IS NOT NULL) AS con_subcategoria
FROM analitica.acto_v
WHERE etapa IN ('adjudicacion','preadjudicacion')
GROUP BY 1, 2;

-- Jerarquía con volumen: para ver qué cuelga de cada jurisdicción
CREATE VIEW analitica.organismo_jerarquia AS
SELECT coalesce(u.poder, '(sin dato)') AS poder, coalesce(u.jurisdiccion, '(sin jurisdicción)') AS jurisdiccion,
       u.tipo_unidad, u.organismo, u.sigla, u.dependencia_sigla, u.entidad_publicada, u.origen, u.clave,
       u.n_normas, u.ultima_publicacion
FROM ref.unidad u;

-- =====================================================================
-- IGJ: autoridades y socios de los proveedores
-- La persona se identifica por tipo y número de documento, no por nombre.
-- Vigente = aparece en el último corte de IGJ cargado.
-- Cubre solo entidades inscriptas en IGJ (Ciudad); sociedades de otras
-- jurisdicciones no figuran.
-- =====================================================================
CREATE VIEW analitica.proveedor_igj AS
WITH prov AS (
  SELECT af.cuit, count(DISTINCT af.id_norma) AS actos,
         count(DISTINCT af.id_norma) FILTER (WHERE af.rol IN ('adjudicada','preadjudicada')) AS actos_ganados
  FROM bo.acto_firma af WHERE af.cuit IS NOT NULL GROUP BY af.cuit
), ult AS (SELECT max(periodo) AS periodo FROM igj.corte)
SELECT p.cuit, coalesce(e.razon_social, en.razon_social) AS razon_social, p.actos, p.actos_ganados,
       en.numero_correlativo, en.tipo_societario, en.dada_de_baja,
       a.rol, a.tipo_documento, a.numero_documento, a.apellido_nombre,
       a.primer_corte, a.ultimo_corte,
       -- figura en el último archivo de IGJ. NO significa que sea autoridad hoy: IGJ conserva
       -- autoridades de inscripciones viejas que nunca se dieron de baja.
       (a.ultimo_corte = ult.periodo) AS en_ultimo_corte
FROM prov p
JOIN igj.entidad en ON en.cuit = p.cuit
JOIN igj.autoridad a ON a.numero_correlativo = en.numero_correlativo
LEFT JOIN ref.empresa e ON e.cuit = p.cuit
CROSS JOIN ult;

-- Personas vinculadas (como autoridad, socio o representante) a dos o más proveedores
CREATE VIEW analitica.persona_multiproveedor AS
SELECT tipo_documento, numero_documento, max(apellido_nombre) AS apellido_nombre,
       count(DISTINCT cuit) AS proveedores,
       count(DISTINCT cuit) FILTER (WHERE en_ultimo_corte) AS proveedores_en_ultimo_corte,
       sum(actos_ganados) AS actos_ganados,
       string_agg(DISTINCT razon_social || ' (' || rol || ')', ' · ') AS vinculos
FROM analitica.proveedor_igj
GROUP BY tipo_documento, numero_documento
HAVING count(DISTINCT cuit) >= 2;

-- SEÑAL: dos firmas distintas que aparecen en el MISMO acto (como oferentes, desestimadas o
-- ganadoras) y comparten una autoridad, socio o representante (mismo documento).
CREATE VIEW analitica.s_autoridad_compartida AS
SELECT a.id_norma, a.codigo_proceso, a.fecha_publicacion, a.organismo, a.jurisdiccion, a.url_norma,
       x.cuit AS cuit_1, px.razon_social AS firma_1, x.rol AS rol_acto_1, px.rol AS rol_igj_1,
       y.cuit AS cuit_2, py.razon_social AS firma_2, y.rol AS rol_acto_2, py.rol AS rol_igj_2,
       px.tipo_documento, px.numero_documento, px.apellido_nombre AS persona,
       (px.en_ultimo_corte AND py.en_ultimo_corte) AS ambos_en_ultimo_corte
FROM bo.acto_firma x
JOIN bo.acto_firma y ON y.id_norma = x.id_norma AND x.cuit < y.cuit
JOIN analitica.proveedor_igj px ON px.cuit = x.cuit
JOIN analitica.proveedor_igj py ON py.cuit = y.cuit
     AND py.tipo_documento = px.tipo_documento AND py.numero_documento = px.numero_documento
JOIN analitica.acto_v a ON a.id_norma = x.id_norma;

-- Cobertura: cuántos proveedores (con CUIT) están en IGJ y con autoridades
CREATE VIEW analitica.calidad_igj AS
WITH prov AS (SELECT DISTINCT cuit FROM bo.acto_firma WHERE cuit IS NOT NULL)
SELECT count(*) AS proveedores,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM igj.entidad e WHERE e.cuit = p.cuit)) AS en_igj,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM igj.entidad e JOIN igj.autoridad a USING (numero_correlativo)
                                      WHERE e.cuit = p.cuit)) AS con_autoridades,
       count(*) FILTER (WHERE p.cuit / 1000000000 IN (20, 23, 24, 27)) AS personas_humanas
FROM prov p;

-- =====================================================================
-- FUNCIONARIOS (desde gerente) y sus vínculos societarios en IGJ
-- =====================================================================
-- Una fila por persona (documento). Período aproximado: desde la primera designación
-- hasta la última renuncia/cese si es el último movimiento conocido; si no, sigue abierto.
CREATE VIEW analitica.funcionario AS
WITH d AS (
  SELECT f.*, n.fecha_publicacion, coalesce(f.vigencia_desde, n.fecha_publicacion) AS fecha_mov,
         ref.jurisdiccion_de(n.organismo) AS jurisdiccion
  FROM fun.designacion f JOIN bo.norma n USING (id_norma)
  WHERE f.parte = 'resolutiva' OR f.movimiento = 'antecedente'
), ult AS (
  SELECT DISTINCT ON (numero_documento) numero_documento, movimiento AS ultimo_movimiento, fecha_mov AS fecha_ultimo
  FROM d WHERE movimiento IN ('designa','renuncia','cese') ORDER BY numero_documento, fecha_mov DESC, id_norma DESC
)
SELECT d.numero_documento,
       mode() WITHIN GROUP (ORDER BY d.apellido_nombre) FILTER (WHERE d.apellido_nombre <> '') AS apellido_nombre,
       min(d.nivel) AS nivel_max,
       (array_agg(d.cargo ORDER BY d.nivel NULLS LAST, d.fecha_mov DESC) FILTER (WHERE d.cargo IS NOT NULL))[1] AS cargo_max,
       string_agg(DISTINCT d.jurisdiccion, ' / ') AS jurisdicciones,
       min(d.fecha_mov) FILTER (WHERE d.movimiento = 'designa') AS primera_designacion,
       u.ultimo_movimiento, u.fecha_ultimo,
       CASE WHEN u.ultimo_movimiento IN ('renuncia','cese') THEN u.fecha_ultimo END AS hasta,
       count(DISTINCT d.id_norma) AS normas
FROM d LEFT JOIN ult u USING (numero_documento)
GROUP BY d.numero_documento, u.ultimo_movimiento, u.fecha_ultimo;

-- Funcionario × entidades en IGJ (por documento). Incluye entidades que no contratan con la Ciudad.
CREATE VIEW analitica.funcionario_igj AS
WITH ult AS (SELECT max(periodo) AS periodo FROM igj.corte),
prov AS (SELECT cuit, count(DISTINCT id_norma) AS actos,
                count(DISTINCT id_norma) FILTER (WHERE rol IN ('adjudicada','preadjudicada')) AS actos_ganados
         FROM bo.acto_firma WHERE cuit IS NOT NULL GROUP BY cuit)
SELECT f.numero_documento, f.apellido_nombre AS funcionario, f.nivel_max, f.cargo_max, f.jurisdicciones,
       f.primera_designacion, f.hasta,
       a.apellido_nombre AS nombre_en_igj, a.rol AS rol_igj, (a.ultimo_corte = ult.periodo) AS en_ultimo_corte,
       e.numero_correlativo, e.razon_social, e.cuit, e.tipo_societario, e.dada_de_baja,
       igj.es_estatal(e.razon_social) AS es_estatal,
       igj.es_sin_fines_de_lucro(e.tipo_societario, e.razon_social) AS sin_fines_de_lucro,
       NOT (igj.es_estatal(e.razon_social) OR igj.es_sin_fines_de_lucro(e.tipo_societario, e.razon_social)) AS relevante,
       coalesce(p.actos, 0) AS actos_con_la_ciudad, coalesce(p.actos_ganados, 0) AS actos_ganados
FROM analitica.funcionario f
JOIN igj.autoridad a ON a.numero_documento = f.numero_documento AND a.tipo_documento IN ('DNI','LE','LC')
JOIN igj.entidad e USING (numero_correlativo)
LEFT JOIN prov p ON p.cuit = e.cuit
CROSS JOIN ult;

-- SEÑAL: actos en los que una sociedad vinculada a un funcionario (autoridad, socio o representante
-- según IGJ hoy) participa de una compra de la Ciudad. Marca si el acto cae dentro del período
-- del funcionario y si es de la misma jurisdicción en la que fue designado.
-- IGJ no informa desde cuándo la persona integra la sociedad: confirmar con los edictos.
CREATE VIEW analitica.s_funcionario_proveedor AS
SELECT fi.numero_documento, fi.funcionario, fi.nivel_max, fi.cargo_max, fi.jurisdicciones AS jurisdicciones_funcionario,
       fi.primera_designacion, fi.hasta, fi.razon_social, fi.cuit, fi.rol_igj, fi.en_ultimo_corte, fi.relevante,
       a.id_norma, a.fecha_publicacion, a.codigo_proceso, a.etapa, af.rol AS rol_en_acto, a.organismo,
       a.jurisdiccion AS jurisdiccion_acto, a.categoria, a.objeto, a.monto_total, a.url_norma,
       (a.fecha_publicacion >= fi.primera_designacion
        AND (fi.hasta IS NULL OR a.fecha_publicacion <= fi.hasta)) AS durante_funcion,
       (position(a.jurisdiccion IN coalesce(fi.jurisdicciones, '')) > 0) AS misma_jurisdiccion
FROM analitica.funcionario_igj fi
JOIN bo.acto_firma af ON af.cuit = fi.cuit
JOIN analitica.acto_v a ON a.id_norma = af.id_norma;

CREATE VIEW analitica.calidad_funcionarios AS
SELECT (SELECT count(*) FROM bo.documento WHERE proposito = 'designacion') AS normas_encoladas,
       (SELECT count(*) FROM bo.documento WHERE proposito = 'designacion' AND estado = 'ok') AS normas_con_texto,
       (SELECT count(*) FROM fun.norma_parseada) AS normas_parseadas,
       (SELECT count(*) FROM fun.norma_parseada WHERE menciones = 0) AS normas_sin_documento,
       (SELECT count(DISTINCT numero_documento) FROM fun.designacion) AS personas,
       (SELECT count(DISTINCT numero_documento) FROM analitica.funcionario_igj) AS personas_en_igj,
       (SELECT count(DISTINCT numero_documento) FROM analitica.funcionario_igj WHERE actos_con_la_ciudad > 0 AND relevante)
         AS personas_con_sociedad_que_contrata,
       (SELECT count(*) FROM fun.designacion WHERE parte = 'resolutiva' AND nivel IS NULL) AS menciones_sin_nivel;
