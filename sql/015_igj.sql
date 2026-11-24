-- =====================================================================
-- IGJ: entidades constituidas en la Inspección General de Justicia.
-- Fuente: datos.jus.gob.ar, dataset "Entidades constituidas en la IGJ" (CC BY 4.0).
-- Cada zip trae uno o más cortes mensuales (igj-<tabla>-AAAAMM.csv). Se cargan
-- en orden; cada fila guarda el primer y último corte en que apareció. Así, con
-- cargas periódicas, se reconstruye cuándo entra y sale una autoridad o socio
-- aunque IGJ no publique fechas de designación.
-- Vigente = aparece en el último corte cargado (igj.corte con el mayor periodo).
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS igj;

CREATE TABLE IF NOT EXISTS igj.corte (
  periodo      int PRIMARY KEY,                 -- AAAAMM del archivo
  archivo_id   bigint REFERENCES ctl.archivo_fuente(id),
  cargado_en   timestamptz NOT NULL DEFAULT now(),
  filas        jsonb
);

CREATE TABLE IF NOT EXISTS igj.entidad (
  numero_correlativo  bigint PRIMARY KEY,
  tipo_societario     text,
  razon_social        text,
  cuit                bigint,
  dada_de_baja        boolean NOT NULL DEFAULT false,
  detalle_baja        text,
  primer_corte        int NOT NULL,
  ultimo_corte        int NOT NULL
);
CREATE INDEX IF NOT EXISTS igj_entidad_cuit_idx ON igj.entidad (cuit);

-- Una fila por (entidad, rol, documento). El nombre se guarda como vino en el último corte
-- (IGJ repite a la misma persona con variantes: "ALVAREZ HORACIO RAUL" / "Horacio Raúl, Alvarez").
CREATE TABLE IF NOT EXISTS igj.autoridad (
  numero_correlativo  bigint NOT NULL,
  rol                 text NOT NULL,            -- AUTORIDAD | SOCIO | REPRESENTANTE | (vacío)
  tipo_documento      text NOT NULL,            -- DNI, LE, LC, CI, PASAPORTE, OTROS
  numero_documento    text NOT NULL,            -- solo dígitos/letras, sin puntos
  apellido_nombre     text NOT NULL,
  nombres_variantes   int NOT NULL DEFAULT 1,
  genero              text,
  primer_corte        int NOT NULL,
  ultimo_corte        int NOT NULL,
  PRIMARY KEY (numero_correlativo, rol, tipo_documento, numero_documento)
);
CREATE INDEX IF NOT EXISTS igj_autoridad_doc_idx ON igj.autoridad (tipo_documento, numero_documento);

CREATE TABLE IF NOT EXISTS igj.domicilio (
  numero_correlativo  bigint NOT NULL,
  tipo_domicilio      text NOT NULL,
  calle               text, numero text, localidad text, provincia text, codigo_postal text,
  primer_corte        int NOT NULL,
  ultimo_corte        int NOT NULL,
  PRIMARY KEY (numero_correlativo, tipo_domicilio, calle, numero)
);

CREATE TABLE IF NOT EXISTS igj.balance (
  numero_correlativo  bigint NOT NULL,
  fecha_balance       date NOT NULL,
  fecha_presentacion  date,
  capital_informado   numeric,
  primer_corte        int NOT NULL,
  ultimo_corte        int NOT NULL,
  PRIMARY KEY (numero_correlativo, fecha_balance)
);

CREATE TABLE IF NOT EXISTS igj.asamblea (
  numero_correlativo  bigint NOT NULL,
  tipo_asamblea       text NOT NULL,
  fecha_realizacion   date NOT NULL,
  fecha_presentacion  date,
  primer_corte        int NOT NULL,
  ultimo_corte        int NOT NULL,
  PRIMARY KEY (numero_correlativo, tipo_asamblea, fecha_realizacion)
);

-- Clasificación de entidades para filtrar vínculos que no son interés privado:
-- empresas del Estado (un funcionario en el directorio de AUSA es una designación estatal)
-- y entidades sin fines de lucro (ser socio de un club no es un vínculo comercial).
CREATE OR REPLACE FUNCTION igj.es_estatal(p_razon text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p_razon, '') ~* concat_ws('|',
    '\m(S\.\s?E|SOCIEDAD DEL ESTADO|S\.A\.U\. ?ESTATAL)\M', 'AUTOPISTAS URBANAS', 'CORREO OFICIAL', 'NACION SEGUROS',
    'BANCO (CIUDAD|DE LA CIUDAD|DE LA NACION)', 'LOTERIA DE LA CIUDAD', 'CORPORACION BUENOS AIRES SUR',
    'SUBTERRANEOS DE BUENOS AIRES', 'AGUA Y SANEAMIENTOS ARGENTINOS', 'ARSAT', 'CEAMSE', 'FACTURACION Y COBRANZA',
    'TRENES ARGENTINOS', 'OPERADORA FERROVIARIA', 'RADIO Y TELEVISION ARGENTINA', 'EDUCAR S', 'PROVINCIA SEGUROS',
    'BANCO PROVINCIA', 'GRUPO BAPRO', 'EMPRESA ARGENTINA DE NAVEGACION AEREA', 'INTERCARGO')
$$;
CREATE OR REPLACE FUNCTION igj.es_sin_fines_de_lucro(p_tipo text, p_razon text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p_tipo, '') ~* 'ASOCIACION|FUNDACION|CAMARA|COOPERATIVA|MUTUAL|SIN FINES'
      OR coalesce(p_razon, '') ~* '^(CLUB|ASOCIACION|FUNDACION|CAMARA|COLEGIO|CONSEJO|INSTITUTO UNIVERSITARIO)\M'
$$;
