-- =====================================================================
-- Funcionarios (desde gerente operativo hacia arriba) extraídos de las normas
-- de designación, renuncia y cese publicadas en el Boletín Oficial.
-- La persona se identifica por número de documento (DNI o el contenido en el CUIL).
-- =====================================================================
ALTER TABLE bo.documento ADD COLUMN IF NOT EXISTS proposito text NOT NULL DEFAULT 'licitacion';
CREATE INDEX IF NOT EXISTS documento_proposito_idx ON bo.documento (proposito, estado);

CREATE SCHEMA IF NOT EXISTS fun;

-- Normas parseadas (para re-parsear solo lo de versión vieja)
CREATE TABLE IF NOT EXISTS fun.norma_parseada (
  id_norma        bigint PRIMARY KEY REFERENCES bo.norma(id_norma),
  menciones       int NOT NULL,
  parser_version  text NOT NULL,
  parseado_en     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fun.designacion (
  id_norma          bigint NOT NULL REFERENCES bo.norma(id_norma),
  orden             int NOT NULL,
  apellido_nombre   text,
  numero_documento  text NOT NULL,
  cuil              text,
  movimiento        text NOT NULL,      -- designa | renuncia | cese | antecedente | otro
  parte             text NOT NULL,      -- resolutiva | considerandos
  cargo             text,
  nivel             int,                -- 1 ministro/jefe de gabinete · 2 secretario/titular de ente · 3 subsecretario · 4 director general · 5 gerente
  vigencia_desde    date,
  PRIMARY KEY (id_norma, orden)
);
CREATE INDEX IF NOT EXISTS designacion_doc_idx ON fun.designacion (numero_documento);

-- Qué normas se bajan: sección Poder Ejecutivo u Órganos de Control, con un movimiento de
-- personal en el sumario y un cargo desde gerente hacia arriba.
CREATE OR REPLACE FUNCTION fun.es_norma_jerarquica(p_seccion text, p_sumario text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p_seccion, '') ~* 'poder ejecutivo|organos de control|órganos de control'
     AND coalesce(p_sumario, '') ~* 'design|nombr|renuncia|\mcese|\mcesa|limita|encomiend|desafecta'
     AND coalesce(p_sumario, '') ~* concat_ws('|',
           '\mministr[oa]\M', 'jef[ea] de gabinete', 'vicejef', '\msubsecretari[oa]', '\msecretari[oa]\M',
           'administrador[a]? gubernamental', 'president[ea]', 'vicepresident', 'director[a]? (titular|suplente)',
           's[ií]ndic', 'procurador', 'titular de(l| la) (ente|organismo|agencia|instituto|unidad)',
           'director[a]? general', 'director[a]? ejecutiv', 'subdirector[a]? general', '\mgerente\M')
     AND coalesce(p_sumario, '') !~* 'ministerio p[uú]blico|secretari[oa] (letrad|de juzgado|privad)|subgerente'
$$;

CREATE OR REPLACE FUNCTION fun.encolar_designaciones() RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  INSERT INTO bo.documento (id_norma, estado, proposito)
  SELECT n.id_norma, 'pendiente', 'designacion'
  FROM bo.norma n
  WHERE n.url_norma IS NOT NULL AND fun.es_norma_jerarquica(n.seccion, n.sumario)
  ON CONFLICT (id_norma) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
