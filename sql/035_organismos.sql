-- =====================================================================
-- Jerarquía de organismos: poder -> jurisdicción -> unidad.
-- Fuente: la API del Boletín agrupa cada norma por "organismo", que es la
-- jurisdicción (ministerio, secretaría, órgano) al momento de publicar; la unidad
-- que emite (hospital, dirección general) es la sigla del nombre de la norma:
-- "Contratación Menor / Llamado N° 3986/HGAT/26" -> HGAT.
-- Los nombres largos de las unidades están en ref.unidad_nombre (por sigla).
-- ref.unidad se reconstruye con ref.actualizar_unidades() (corre al final
-- de parsear). Las filas con origen='manual' no se pisan: para corregir una
-- unidad, editarla y poner origen='manual'.
-- =====================================================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='ref' AND table_name='unidad')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='ref' AND table_name='unidad' AND column_name='clave') THEN
    DROP TABLE ref.unidad CASCADE;
  END IF;
END $$;

-- Sigla de la unidad emisora, tomada del nombre de la norma ("... N° 3986/HGAT/26" -> HGAT)
CREATE OR REPLACE FUNCTION ref.sigla_de_nombre(p_nombre text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT nullif(upper(substring(p_nombre from '/\s*([A-Za-z][A-Za-z0-9ÁÉÍÓÚÑáéíóúñ-]*)\s*/\s*\d{2,4}\s*$')), '')
$$;



CREATE TABLE IF NOT EXISTS ref.unidad (
  clave               text PRIMARY KEY,   -- ref.clave_unidad(organismo, sigla)
  organismo           text,               -- nombre a mostrar
  sigla               text,               -- "emisor" de la API (HGACA, DGCYC, ...)
  entidad_publicada   text,               -- "entidad" de la API, tal cual
  jurisdiccion        text,               -- entidad normalizada (renombres y erratas)
  poder               text,               -- Ejecutivo | Legislativo | Judicial | Organismo autónomo | Nacional
  tipo_unidad         text,               -- Hospital | Dirección General | Instituto | ...
  dependencia_sigla   text,               -- sigla entre paréntesis: (SSASS), (SSGO-MHGC)
  n_normas            int,
  ultima_publicacion  date,
  origen              text NOT NULL DEFAULT 'base' CHECK (origen IN ('base','manual'))
);

-- Nombres largos de unidades por sigla. Se heredan de la carga anterior (cuando el Boletín publicaba
-- el nombre de cada unidad); las siglas nuevas quedan con la sigla como nombre hasta que se carguen acá
-- (origen='manual' para no pisarlas).
CREATE TABLE IF NOT EXISTS ref.unidad_nombre (
  sigla        text PRIMARY KEY,
  nombre       text NOT NULL,
  tipo_unidad  text,
  jurisdiccion text,            -- la de la última vez que se vio (orientativa)
  origen       text NOT NULL DEFAULT 'base' CHECK (origen IN ('base','manual'))
);
INSERT INTO ref.unidad_nombre (sigla, nombre, tipo_unidad, jurisdiccion)
SELECT DISTINCT ON (upper(btrim(sigla))) upper(btrim(sigla)), organismo, tipo_unidad, jurisdiccion
FROM ref.unidad
WHERE coalesce(btrim(sigla), '') <> '' AND clave NOT LIKE '%@%' AND organismo IS NOT NULL
ORDER BY upper(btrim(sigla)), n_normas DESC NULLS LAST
ON CONFLICT (sigla) DO NOTHING;
-- las filas con la clave vieja (nombre publicado) ya no matchean con nada
DELETE FROM ref.unidad WHERE origen = 'base' AND clave NOT LIKE '%@%';

-- Renombres de jurisdicciones (misma estructura con otro nombre) y erratas del Boletín
CREATE TABLE IF NOT EXISTS ref.jurisdiccion_alias (
  nombre_publicado text PRIMARY KEY,
  jurisdiccion     text NOT NULL,
  origen           text NOT NULL DEFAULT 'manual' CHECK (origen IN ('base','manual'))
);
DELETE FROM ref.jurisdiccion_alias WHERE origen = 'base';
-- Solo renombres (la misma estructura sigue con otro nombre, sin superposición de fechas) y erratas.
-- Las divisiones y fusiones NO se unifican: Justicia y Seguridad (hasta 2023) -> Justicia + Seguridad;
-- Ambiente y Espacio Público (hasta 2020) -> Espacio Público e Higiene Urbana + Secretaría de Ambiente;
-- Desarrollo Urbano y Transporte (hasta 2020) -> pasó a Jefatura de Gabinete.
INSERT INTO ref.jurisdiccion_alias (nombre_publicado, jurisdiccion, origen) VALUES
 ('Ministerio de Educación e Innovación', 'Ministerio de Educación', 'base'),                                -- hasta 2021
 ('Ministerio de Economía y Finanzas', 'Ministerio de Hacienda y Finanzas', 'base'),                         -- hasta 2021
 ('Ministerio de Hábitat y Desarrollo Humano', 'Ministerio de Desarrollo Humano y Hábitat', 'base'),         -- hasta 2020
 ('Ministerio de Desarrollo Económico y Producción', 'Ministerio de Desarrollo Económico', 'base'),          -- hasta 2023
 ('Ministerio de Infraestructura', 'Ministerio de Movilidad e Infraestructura', 'base'),                     -- 2024-2025
 ('Ente Regulador de los Servicios Públicos de la Ciudad Autónoma de Buenos Aires',
  'Ente Único Regulador de los Servicios Públicos de la Ciudad Autónoma de Buenos Aires', 'base'),           -- hasta 2024
 ('Secretaría de Comunicación Contenidos y Participación Ciudadana', 'Secretaría de Comunicación', 'base'),  -- hasta 2023
 ('Secretaría General y Relaciones Internacionales', 'Secretaría General', 'base'),                          -- hasta 2023
 ('Ex Secretaría de Ambiente', 'Secretaría de Ambiente', 'base'),
 ('Sercetaría de Comunicación', 'Secretaría de Comunicación', 'base'),                                      -- errata
 ('Unidad de Proyeccion Federal y Desarrollo Territorial', 'Unidad de Proyección Federal y Desarrollo Territorial UPFDT', 'base')
ON CONFLICT (nombre_publicado) DO NOTHING;

CREATE OR REPLACE FUNCTION ref.jurisdiccion_de(p_entidad text) RETURNS text
LANGUAGE sql STABLE AS $$
  -- "X - Y": normas conjuntas o entes dentro de una jurisdicción.
  --  * "Ministerio de Hacienda y Finanzas - Lotería de la Ciudad...": la jurisdicción es la primera parte.
  --  * "Ministerio de Hacienda y Finanzas - Ministerio de Salud" (resolución conjunta): es de la segunda; Hacienda
  --    o Jefatura de Gabinete firman por presupuesto o personal.
  WITH e AS (SELECT btrim(regexp_replace(p_entidad, '[\s-]+$', '')) AS e),
  p AS (SELECT e.e,
               nullif(btrim(split_part(regexp_replace(e.e, '\s+-\s+', ' | ', 'g'), ' | ', 1)), '') AS p1,
               nullif(btrim(split_part(regexp_replace(e.e, '\s+-\s+', ' | ', 'g'), ' | ', 2)), '') AS p2
        FROM e),
  j AS (SELECT CASE WHEN p1 IN ('Ministerio de Hacienda y Finanzas', 'Ministerio de Economía y Finanzas',
                                'Jefatura de Gabinete de Ministros')
                     AND p2 ~ '^(Ministerio|Secretar[ií]a|Vicejefatura|Jefatura|Consejo|Procuraci[oó]n|Unidad)'
                    THEN p2 ELSE p1 END AS j, e
        FROM p)
  SELECT coalesce((SELECT a.jurisdiccion FROM ref.jurisdiccion_alias a WHERE a.nombre_publicado = j.e),
                  (SELECT a.jurisdiccion FROM ref.jurisdiccion_alias a WHERE a.nombre_publicado = j.j),
                  j.j)
  FROM j
$$;

-- Clave de unidad: SIGLA@jurisdicción (la misma sigla en dos jurisdicciones son dos unidades; los renombres
-- de ministerio no parten la unidad porque la jurisdicción ya viene normalizada)
DROP FUNCTION IF EXISTS ref.clave_unidad(text, text) CASCADE;   -- arrastra vistas de analitica: 040 las recrea
CREATE FUNCTION ref.clave_unidad(p_entidad text, p_sigla text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(upper(btrim(p_sigla)), ''), '?') || '@' || coalesce(ref.jurisdiccion_de(p_entidad), '?')
$$;

CREATE OR REPLACE FUNCTION ref.poder_de(p_entidad text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_entidad IS NULL THEN NULL
    WHEN p_entidad ~* '\mnacional\M|de la naci[oó]n' THEN 'Nacional'
    WHEN p_entidad ~* 'magistratura|tribunal superior|ministerio p[uú]blico' THEN 'Judicial'
    WHEN p_entidad ~* 'legislatura|auditor[ií]a general|defensor[ií]a del pueblo' THEN 'Legislativo'
    WHEN p_entidad ~* 'ente (único |unico )?regulador' THEN 'Organismo autónomo'
    ELSE 'Ejecutivo' END
$$;

CREATE OR REPLACE FUNCTION ref.tipo_unidad_de(p_organismo text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_organismo IS NULL THEN 'Otro'
    WHEN p_organismo ~* '^hosp|hospital' THEN 'Hospital'
    WHEN p_organismo ~* '^junta comunal|^comuna' THEN 'Comuna'
    WHEN p_organismo ~* '^inst(\.|ituto)' THEN 'Instituto'
    WHEN p_organismo ~* '^d\.?\s*g\.?\s|^d\.g\.|direcci[oó]n general|^dir\.\s*gral' THEN 'Dirección General'
    WHEN p_organismo ~* '^ministerio' THEN 'Ministerio'
    WHEN p_organismo ~* '^subsec|^s\.\s*s\.' THEN 'Subsecretaría'
    WHEN p_organismo ~* '^secretar|^sec\.' THEN 'Secretaría'
    WHEN p_organismo ~* 'agencia|administraci[oó]n gubernamental' THEN 'Agencia'
    WHEN p_organismo ~* '^ente|s\.\s*e\.|s\.\s*a\.|sociedad del estado|loter[ií]a|^banco|corporaci[oó]n|autopistas' THEN 'Ente o empresa'
    WHEN p_organismo ~* '^upe|^uni\.|unidad' THEN 'Unidad de proyecto'
    WHEN p_organismo ~* 'consejo|tribunal|ministerio p[uú]blico|legislatura|auditor|defensor|sindicatura|procuraci|comisi[oó]n' THEN 'Órgano'
    WHEN p_organismo ~* 'complejo|centro cultural|radio|teatro|museo|talleres' THEN 'Organismo fuera de nivel'
    ELSE 'Otro' END
$$;

-- Unidad de cada norma con actos, precalculada (calcular la clave fila por fila en las vistas es caro)
CREATE TABLE IF NOT EXISTS ref.norma_unidad (
  id_norma bigint PRIMARY KEY,
  clave    text NOT NULL
);

-- Reconstruye las filas 'base' a partir de las normas con actos de licitación.
CREATE OR REPLACE FUNCTION ref.actualizar_unidades() RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  INSERT INTO ref.norma_unidad (id_norma, clave)
  SELECT n.id_norma, ref.clave_unidad(n.organismo, ref.sigla_de_nombre(n.nombre))
  FROM bo.norma n WHERE EXISTS (SELECT 1 FROM bo.acto a WHERE a.id_norma = n.id_norma)
  ON CONFLICT (id_norma) DO UPDATE SET clave = EXCLUDED.clave WHERE ref.norma_unidad.clave <> EXCLUDED.clave;

  WITH n AS (
    SELECT nu.clave, ref.sigla_de_nombre(n.nombre) AS sigla, btrim(regexp_replace(n.organismo, '[\s-]+$', '')) AS entidad,
           n.fecha_publicacion
    FROM ref.norma_unidad nu JOIN bo.norma n USING (id_norma)
  ), u AS (
    SELECT clave, max(sigla) AS sigla, mode() WITHIN GROUP (ORDER BY entidad) AS entidad,
           count(*) AS n_normas, max(fecha_publicacion) AS ultima
    FROM n GROUP BY 1
  )
  INSERT INTO ref.unidad (clave, organismo, sigla, entidad_publicada, jurisdiccion, poder, tipo_unidad,
                          dependencia_sigla, n_normas, ultima_publicacion, origen)
  SELECT u.clave,
         coalesce(un.nombre, coalesce(u.sigla, '(sin sigla)') || ' (' || coalesce(ref.jurisdiccion_de(u.entidad), 's/d') || ')'),
         u.sigla, u.entidad, ref.jurisdiccion_de(u.entidad), ref.poder_de(u.entidad),
         coalesce(un.tipo_unidad, CASE WHEN u.sigla ~ '^(HOSP|HG|HM|HI|HN|HO|HQ|HSL|HBR|HBU|HRR)' THEN 'Hospital'
                                       WHEN u.sigla ~ '^DG' THEN 'Dirección General'
                                       WHEN u.sigla ~ '^SS' THEN 'Subsecretaría'
                                       WHEN u.sigla ~ '^SEC' THEN 'Secretaría'
                                       WHEN u.sigla ~ '^COMUNA' THEN 'Comuna'
                                       WHEN u.sigla ~ '^UPE' THEN 'Unidad de proyecto' ELSE 'Otro' END),
         substring(un.nombre from '\(([^)]+)\)\s*$'), u.n_normas, u.ultima, 'base'
  FROM u LEFT JOIN ref.unidad_nombre un ON un.sigla = u.sigla
  ON CONFLICT (clave) DO UPDATE SET
     organismo = EXCLUDED.organismo, sigla = EXCLUDED.sigla, entidad_publicada = EXCLUDED.entidad_publicada,
     jurisdiccion = EXCLUDED.jurisdiccion, poder = EXCLUDED.poder, tipo_unidad = EXCLUDED.tipo_unidad,
     dependencia_sigla = EXCLUDED.dependencia_sigla, n_normas = EXCLUDED.n_normas,
     ultima_publicacion = EXCLUDED.ultima_publicacion
   WHERE ref.unidad.origen = 'base';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  -- las manuales solo actualizan conteos
  UPDATE ref.unidad r SET n_normas = x.c, ultima_publicacion = x.u
  FROM (SELECT nu.clave, count(*) c, max(n.fecha_publicacion) u
        FROM ref.norma_unidad nu JOIN bo.norma n USING (id_norma) GROUP BY 1) x
  WHERE r.clave = x.clave AND r.origen = 'manual';
  RETURN v_n;
END $$;

-- unidad "No se encontró la descripción": el Boletín no publicó el nombre; se identifica por sigla
-- (p. ej. OBSBA = Obra Social de la Ciudad). Corregir a mano en ref.unidad si hace falta.

-- Con la estructura nueva, recalcular de una vez las unidades de las normas ya parseadas
SELECT ref.actualizar_unidades();
