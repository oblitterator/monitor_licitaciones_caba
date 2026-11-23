import "server-only";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { consultar, consultarUna, type Fila } from "./db";
import { consultaPagina, consultaResumen, type Filtros } from "./busqueda";

// Todas las lecturas pasan por la caché de datos de Next (1 h): la base cambia
// una vez por día. `cache` de React evita repetir la consulta dentro de un mismo render.
export const REVALIDAR = 3600;

function cacheado<A extends unknown[], R>(clave: string, fn: (...a: A) => Promise<R>) {
  return cache(unstable_cache(fn, ["v1", clave], { revalidate: REVALIDAR, tags: ["datos"] }));
}

type N = string | null; // numeric de Postgres llega como texto

// ---------------------------------------------------------------------
// Cobertura (encabezado, pie, metodología)
// ---------------------------------------------------------------------
export type Cobertura = {
  primera: string;
  ultima: string;
  norma_primera: string | null;
  norma_ultima: string | null;
  actos: number;
  ipc: number;
  umbrales: number;
  bac: number;
  boletines: number;
  llm: number;
  ultima_ingesta: string | null;
  meses: { mes: string; actos: number }[];
};

export const obtenerCobertura = cacheado("cobertura", async (): Promise<Cobertura> => {
  const r = await consultarUna<Cobertura>(`
    SELECT coalesce(min(fecha_publicacion)::text, '2019-12-01') AS primera,
           coalesce(max(fecha_publicacion)::text, '2019-12-01') AS ultima,
           (SELECT min(fecha_publicacion)::text FROM bo.norma WHERE seccion = 'Licitaciones') AS norma_primera,
           (SELECT max(fecha_publicacion)::text FROM bo.norma WHERE seccion = 'Licitaciones') AS norma_ultima,
           count(*)::int AS actos,
           (SELECT count(*)::int FROM ref.ipc) AS ipc,
           (SELECT count(*)::int FROM ref.umbral_procedimiento) AS umbrales,
           (SELECT count(*)::int FROM bac.release) AS bac,
           (SELECT count(*)::int FROM bo.boletin) AS boletines,
           (SELECT count(*)::int FROM analitica.acto_llm_v) AS llm,
           (SELECT max(fin)::text FROM ctl.ejecucion WHERE ok) AS ultima_ingesta,
           (SELECT coalesce(json_agg(json_build_object('mes', mes, 'actos', n) ORDER BY mes), '[]')
              FROM (SELECT to_char(date_trunc('month', fecha_publicacion), 'YYYY-MM') AS mes, count(*)::int AS n
                    FROM analitica.acto_v GROUP BY 1) m) AS meses
    FROM analitica.acto_v`);
  if (!r) throw new Error("Sin datos de cobertura");
  return r;
});

// ---------------------------------------------------------------------
// Tablero
// ---------------------------------------------------------------------
export type Kpis = {
  procesos: number;
  monto_ars: N;
  procesos_con_monto: number;
  monto_usd: N;
  procesos_usd: number;
  montos_dudosos: number;
  unica: number;
  con_dato_ofertas: number;
  excepcion: number;
  con_procedimiento: number;
  senales_nuevas: number;
  senales_desde: string | null;
  senales_hasta: string | null;
};

/** Expresión de monto en pesos constantes, si hay IPC (texto fijo, sin datos del usuario). */
const factor = (col: string, fechaCol: string, constantes: boolean) =>
  constantes
    ? `${col} * (SELECT f.factor FROM analitica.ipc_factor f WHERE f.mes = date_trunc('month', ${fechaCol})::date)`
    : col;

export const obtenerKpis = cacheado("kpis", async (desde: string, hasta: string, constantes: boolean): Promise<Kpis> => {
  const m = factor("monto_adjudicado", "fecha_adjudicacion", constantes);
  const r = await consultarUna<Kpis>(
    `WITH p AS (
       SELECT DISTINCT codigo_proceso FROM analitica.acto_v
       WHERE codigo_proceso IS NOT NULL AND fecha_publicacion BETWEEN $1::date AND $2::date
     ), pr AS (SELECT x.* FROM analitica.proceso x JOIN p USING (codigo_proceso)),
     adj AS (
       SELECT * FROM analitica.proceso WHERE fecha_adjudicacion BETWEEN $1::date AND $2::date AND monto_adjudicado IS NOT NULL
     ), fin AS (SELECT least($2::date, max(fecha_publicacion)) AS f FROM analitica.acto_v WHERE fecha_publicacion <= $2::date)
     SELECT (SELECT count(*)::int FROM p) AS procesos,
            (SELECT sum(${m}) FROM adj WHERE moneda_adjudicado = 'ARS' AND NOT web.monto_dudoso(monto_adjudicado, 'ARS')) AS monto_ars,
            (SELECT count(*)::int FROM adj WHERE moneda_adjudicado = 'ARS' AND NOT web.monto_dudoso(monto_adjudicado, 'ARS')) AS procesos_con_monto,
            (SELECT sum(monto_adjudicado) FROM adj WHERE moneda_adjudicado = 'USD' AND NOT web.monto_dudoso(monto_adjudicado, 'USD')) AS monto_usd,
            (SELECT count(*)::int FROM adj WHERE moneda_adjudicado = 'USD') AS procesos_usd,
            (SELECT count(*)::int FROM adj WHERE web.monto_dudoso(monto_adjudicado, moneda_adjudicado)) AS montos_dudosos,
            (SELECT count(*) FILTER (WHERE unica_oferta)::int FROM pr) AS unica,
            (SELECT count(*) FILTER (WHERE unica_oferta IS NOT NULL)::int FROM pr) AS con_dato_ofertas,
            (SELECT count(*) FILTER (WHERE tipo_proc IN ('CME','CDI'))::int FROM pr) AS excepcion,
            (SELECT count(*) FILTER (WHERE tipo_proc IS NOT NULL)::int FROM pr) AS con_procedimiento,
            (SELECT count(*)::int FROM web.senal_caso s, fin WHERE s.tipo <> 'excepcion' AND s.fecha BETWEEN fin.f - 6 AND fin.f) AS senales_nuevas,
            (SELECT (f - 6)::text FROM fin) AS senales_desde,
            (SELECT f::text FROM fin) AS senales_hasta`,
    [desde, hasta],
  );
  if (!r) throw new Error("Sin KPIs");
  return r;
});

export type ActoCorto = {
  id_norma: string;
  codigo_proceso: string | null;
  fecha_publicacion: string;
  etapa: string | null;
  objeto: string | null;
  organismo: string | null;
  organismo_id: string | null;
  monto_total: N;
  moneda: string | null;
  monto_origen: string | null;
  monto_fuente: string | null;
  monto_dudoso: boolean;
  confianza: "alta" | "media" | "baja";
  url_norma: string | null;
  tipo_proc: string | null;
  senales: string[];
};

/** Publicaciones del último día con actos (hasta `hasta`), para "Hoy en el Boletín". */
export const obtenerUltimoBoletin = cacheado("ultimo-boletin", async (hasta: string) => {
  const dia = await consultarUna<{ f: string | null }>(
    `SELECT max(fecha_publicacion)::text AS f FROM web.acto_busqueda WHERE fecha_publicacion <= $1::date`,
    [hasta],
  );
  if (!dia?.f) return { fecha: null, actos: [] as ActoCorto[] };
  const actos = await consultar<ActoCorto>(
    `SELECT id_norma::text, codigo_proceso, fecha_publicacion, etapa, objeto, organismo, organismo_id, monto_total, moneda,
            monto_origen, monto_fuente, monto_dudoso, confianza, url_norma, tipo_proc, to_json(senales) AS senales
     FROM web.acto_busqueda WHERE fecha_publicacion = $1::date ORDER BY monto_total DESC NULLS LAST, id_norma`,
    [dia.f],
  );
  return { fecha: dia.f, actos };
});

export type CasoSenal = {
  tipo: string;
  codigo_proceso: string;
  fecha: string | null;
  organismo_id: string | null;
  organismo: string | null;
  monto: N;
  moneda: string | null;
  cuit: string | null;
  detalle: Record<string, unknown>;
  objeto: string | null;
  url_norma: string | null;
  fecha_acto: string | null;
  razon_social: string | null;
  monto_dudoso: boolean;
};

const SELECT_CASO = `
  SELECT s.tipo, s.codigo_proceso, s.fecha::text, s.organismo_id, s.organismo, s.monto, s.moneda, s.cuit::text, s.detalle,
         p.objeto, a.url_norma, a.fecha_publicacion::text AS fecha_acto, e.razon_social,
         web.monto_dudoso(s.monto, s.moneda) AS monto_dudoso
  FROM web.senal_caso s
  LEFT JOIN analitica.proceso p USING (codigo_proceso)
  LEFT JOIN bo.norma a ON a.id_norma = s.id_norma
  LEFT JOIN ref.empresa e ON e.cuit = s.cuit`;

export const obtenerSenalesRecientes = cacheado("senales-recientes", async (hasta: string, n: number) =>
  consultar<CasoSenal>(
    `${SELECT_CASO} WHERE s.tipo NOT IN ('excepcion') AND s.fecha <= $1::date
     ORDER BY s.fecha DESC, (s.tipo = 'fraccionamiento'), s.codigo_proceso LIMIT $2`,
    [hasta, n],
  ),
);

export type FilaRanking = { id: string; nombre: string | null; procesos: number; monto: N; pct: N; sub?: string };

export const obtenerRankingOrganismos = cacheado(
  "ranking-org",
  async (desde: string, hasta: string, constantes: boolean, n: number) => {
    const m = factor("monto_adjudicado", "fecha_adjudicacion", constantes);
    return consultar<FilaRanking>(
      `WITH b AS (
         SELECT organismo_id AS id, organismo, ${m} AS monto
         FROM analitica.proceso
         WHERE fecha_adjudicacion BETWEEN $1::date AND $2::date AND moneda_adjudicado = 'ARS'
           AND monto_adjudicado IS NOT NULL AND NOT web.monto_dudoso(monto_adjudicado, 'ARS')
       ), t AS (SELECT sum(monto) AS total FROM b)
       SELECT id, mode() WITHIN GROUP (ORDER BY organismo) AS nombre, count(*)::int AS procesos, sum(monto) AS monto,
              round(100 * sum(monto) / nullif((SELECT total FROM t), 0), 1) AS pct
       FROM b GROUP BY id ORDER BY sum(monto) DESC NULLS LAST LIMIT $3`,
      [desde, hasta, n],
    );
  },
);

export const obtenerRankingProveedores = cacheado(
  "ranking-prov",
  async (desde: string, hasta: string, constantes: boolean, n: number) => {
    const m = constantes ? "g.monto_constante" : "g.monto_asignado";
    const filas = await consultar<FilaRanking>(
      `WITH b AS (
         SELECT g.cuit, g.codigo_proceso, ${m} AS monto
         FROM analitica.ganador g
         WHERE g.fecha_publicacion BETWEEN $1::date AND $2::date AND g.moneda = 'ARS'
           AND g.monto_asignado IS NOT NULL AND NOT web.monto_dudoso(g.monto_asignado, 'ARS')
       ), t AS (SELECT sum(monto) AS total FROM b)
       SELECT b.cuit::text AS id, coalesce(e.razon_social, min(af.nombre_raw)) AS nombre, count(DISTINCT b.codigo_proceso)::int AS procesos,
              sum(b.monto) AS monto, round(100 * sum(b.monto) / nullif((SELECT total FROM t), 0), 1) AS pct
       FROM b LEFT JOIN ref.empresa e ON e.cuit = b.cuit
       LEFT JOIN bo.acto_firma af ON af.cuit = b.cuit AND e.cuit IS NULL
       WHERE b.cuit IS NOT NULL
       GROUP BY b.cuit, e.razon_social ORDER BY sum(b.monto) DESC NULLS LAST LIMIT $3`,
      [desde, hasta, n],
    );
    const sin = await consultarUna<{ n: number; monto: N }>(
      `SELECT count(*)::int AS n, sum(monto_asignado) FILTER (WHERE NOT web.monto_dudoso(monto_asignado, 'ARS')) AS monto
       FROM analitica.ganador WHERE cuit IS NULL AND fecha_publicacion BETWEEN $1::date AND $2::date AND moneda = 'ARS'`,
      [desde, hasta],
    );
    return { filas, sinCuit: sin ?? { n: 0, monto: null } };
  },
);

// ---------------------------------------------------------------------
// Buscador
// ---------------------------------------------------------------------
export type FilaBusqueda = ActoCorto & { expediente: string | null; nombre_norma: string | null; codigo_fuente: string | null; etapa_fuente: string | null };

export const buscarActos = cacheado("buscar", async (f: Filtros) => {
  const pag = consultaPagina(f);
  const res = consultaResumen(f);
  const [filas, resumen] = await Promise.all([
    consultar<FilaBusqueda>(pag.texto, pag.params),
    consultarUna<{ actos: number; procesos: number; ars: N; usd: N; adjudicaciones: number; adj_sin_monto: number }>(res.texto, res.params),
  ]);
  return { filas, resumen: resumen ?? { actos: 0, procesos: 0, ars: null, usd: null, adjudicaciones: 0, adj_sin_monto: 0 } };
});

export const obtenerOrganismosOpciones = cacheado("org-opciones", async () =>
  consultar<{ id: string; nombre: string; n: number }>(
    `SELECT organismo_id AS id, mode() WITHIN GROUP (ORDER BY organismo) AS nombre, count(*)::int AS n
     FROM analitica.acto_v WHERE organismo_id IS NOT NULL GROUP BY 1 ORDER BY 2`,
  ),
);

// ---------------------------------------------------------------------
// Ficha de proceso
// ---------------------------------------------------------------------
export type Proceso = {
  codigo_proceso: string;
  uoa: number | null;
  tipo_proc: string | null;
  anio_proc: number | null;
  organismo: string | null;
  organismo_id: string | null;
  objeto: string | null;
  fecha_llamado: string | null;
  fecha_preadjudicacion: string | null;
  fecha_adjudicacion: string | null;
  monto_adjudicado: N;
  moneda_adjudicado: string | null;
  monto_preadjudicado: N;
  moneda_preadjudicado: string | null;
  n_ofertas: number | null;
  n_firmas_identificadas: number | null;
  unica_oferta: boolean | null;
  fracasada: boolean | null;
  n_prorrogas: number;
  n_ampliaciones: number;
  n_circulares: number;
  n_modificaciones: number;
  n_actos: number;
};

export type Acto = {
  id_norma: string;
  fecha_publicacion: string;
  organismo: string | null;
  organismo_id: string | null;
  nombre_norma: string | null;
  url_norma: string | null;
  tipo_proc: string | null;
  objeto: string | null;
  expediente: string | null;
  n_ofertas: number | null;
  unica_oferta: boolean | null;
  fracasada: boolean;
  confianza: "alta" | "media" | "baja";
  faltantes: string[];
  parser_version: string;
  monto_origen: string | null;
  etapa: string | null;
  etapa_fuente: string | null;
  codigo_proceso: string | null;
  codigo_fuente: string | null;
  monto_total: N;
  moneda: string | null;
  monto_fuente: string | null;
  usa_llm: boolean;
  llm_modelo: string | null;
  evidencias: Record<string, unknown> | null;
  doc_estado: string | null;
  doc_paginas: number | null;
  doc_extraido: string | null;
  doc_sha: string | null;
};

export type Firma = {
  id_norma: string;
  orden: number;
  nombre_raw: string;
  nombre_norm: string | null;
  rol: string;
  monto: N;
  cuit: string | null;
  resolucion: string | null;
  razon_social: string | null;
  etapa: string | null;
  fecha_publicacion: string;
  fuente: "reglas" | "llm";
  evidencia: string | null;
};

export type Ganador = {
  id_norma: string;
  etapa: string;
  fecha_publicacion: string;
  orden: number;
  nombre_raw: string;
  cuit: string | null;
  razon_social: string | null;
  monto_asignado: N;
  moneda: string | null;
  monto_no_asignable: boolean;
  n_ganadoras: number;
  monto_firma: N;
};

export const obtenerProceso = cacheado("proceso", async (codigo: string) => {
  const [proceso, actos] = await Promise.all([
    consultarUna<Proceso>(
      `SELECT codigo_proceso, uoa, tipo_proc, anio_proc, organismo, organismo_id, objeto, fecha_llamado::text, fecha_preadjudicacion::text,
              fecha_adjudicacion::text, monto_adjudicado, moneda_adjudicado, monto_preadjudicado, moneda_preadjudicado, n_ofertas,
              n_firmas_identificadas, unica_oferta, fracasada, n_prorrogas::int, n_ampliaciones::int, n_circulares::int,
              n_modificaciones::int, n_actos::int
       FROM analitica.proceso WHERE codigo_proceso = $1`,
      [codigo],
    ),
    consultar<Acto>(
      `SELECT c.id_norma::text, c.fecha_publicacion, c.organismo, c.organismo_id, c.nombre_norma, c.url_norma, c.tipo_proc, c.objeto,
              c.expediente, c.n_ofertas, c.unica_oferta, c.fracasada, c.confianza, to_json(c.faltantes) AS faltantes, c.parser_version, c.monto_origen,
              c.etapa, c.etapa_fuente, c.codigo_proceso, c.codigo_fuente, c.monto_total, c.moneda, c.monto_fuente, c.usa_llm,
              c.llm_modelo, l.evidencias, d.estado AS doc_estado, d.paginas AS doc_paginas, d.extraido_en AS doc_extraido,
              d.sha256 AS doc_sha
       FROM analitica.acto_consolidado c
       LEFT JOIN analitica.acto_llm_v l USING (id_norma)
       LEFT JOIN bo.documento d USING (id_norma)
       WHERE c.codigo_proceso = $1
       ORDER BY c.fecha_publicacion, c.id_norma`,
      [codigo],
    ),
  ]);
  if (!proceso && actos.length === 0) return null;
  const [firmas, ganadores, senales, umbrales] = await Promise.all([
    consultar<Firma>(
      `SELECT af.id_norma::text, af.orden, af.nombre_raw, af.nombre_norm, af.rol, af.monto, af.cuit::text, af.resolucion,
              e.razon_social, a.etapa, a.fecha_publicacion, 'reglas' AS fuente, NULL AS evidencia
       FROM bo.acto_firma af JOIN analitica.acto_consolidado a USING (id_norma)
       LEFT JOIN ref.empresa e ON e.cuit = af.cuit
       WHERE a.codigo_proceso = $1
       UNION ALL
       SELECT lf.id_norma::text, lf.orden, lf.nombre_raw, lf.nombre_norm, lf.rol, lf.monto, lf.cuit::text, NULL,
              e.razon_social, a.etapa, a.fecha_publicacion, 'llm', lf.evidencia
       FROM analitica.acto_llm_firma lf JOIN analitica.acto_consolidado a USING (id_norma)
       LEFT JOIN ref.empresa e ON e.cuit = lf.cuit
       WHERE a.codigo_proceso = $1 AND a.usa_llm
         AND NOT EXISTS (SELECT 1 FROM bo.acto_firma x WHERE x.id_norma = lf.id_norma)
       ORDER BY fecha_publicacion, id_norma, orden`,
      [codigo],
    ),
    consultar<Ganador>(
      `SELECT g.id_norma::text, g.etapa, g.fecha_publicacion::text, g.orden, g.nombre_raw, g.cuit::text, e.razon_social, g.monto_asignado,
              g.moneda, g.monto_no_asignable, g.n_ganadoras::int, g.monto_firma
       FROM analitica.ganador g LEFT JOIN ref.empresa e ON e.cuit = g.cuit
       WHERE g.codigo_proceso = $1 ORDER BY g.orden`,
      [codigo],
    ),
    consultar<CasoSenal>(`${SELECT_CASO} WHERE s.codigo_proceso = $1 AND s.tipo <> 'excepcion' ORDER BY s.fecha`, [codigo]),
    consultarUna<{ n: number }>(`SELECT count(*)::int AS n FROM ref.umbral_procedimiento`),
  ]);
  return { proceso: proceso ?? null, actos, firmas, ganadores, senales, hayUmbrales: (umbrales?.n ?? 0) > 0 };
});

// ---------------------------------------------------------------------
// Proveedores
// ---------------------------------------------------------------------
export type ProveedorFila = {
  cuit: string;
  razon_social: string | null;
  tipo_societario: string | null;
  procesos_ganados: number;
  organismos: number;
  monto_nominal_ars: N;
  pct_oferta_unica: N;
  pct_excepcion: N;
  primera: string | null;
  ultima: string | null;
};

export const POR_PAGINA_LISTA = 50;

export const listarProveedores = cacheado("proveedores", async (q: string, orden: string, pagina: number) => {
  const params: unknown[] = [];
  let where = "";
  const qq = q.trim();
  if (qq) {
    const digitos = qq.replace(/[\s.-]/g, "");
    if (/^\d{11}$/.test(digitos)) {
      params.push(digitos);
      where = `WHERE p.cuit = $1::bigint`;
    } else {
      params.push("%" + qq.replace(/[%_\\]/g, "\\$&") + "%", qq);
      where = `WHERE p.razon_social ILIKE $1 OR ref.norm_nombre(p.razon_social) LIKE '%' || ref.norm_nombre($2) || '%'`;
    }
  }
  const ord =
    orden === "procesos"
      ? "p.procesos_ganados DESC, p.monto_nominal_ars DESC NULLS LAST"
      : orden === "nombre"
        ? "p.razon_social ASC NULLS LAST"
        : "p.monto_nominal_ars DESC NULLS LAST, p.procesos_ganados DESC";
  const off = (Math.max(1, pagina) - 1) * POR_PAGINA_LISTA;
  const [filas, total, pendientes] = await Promise.all([
    consultar<ProveedorFila>(
      `SELECT p.cuit::text, p.razon_social, p.tipo_societario, p.procesos_ganados::int, p.organismos::int, p.monto_nominal_ars,
              p.pct_oferta_unica, p.pct_excepcion, p.primera::text, p.ultima::text
       FROM analitica.proveedor p ${where} ORDER BY ${ord}, p.cuit LIMIT ${POR_PAGINA_LISTA} OFFSET ${off}`,
      params,
    ),
    consultarUna<{ n: number }>(`SELECT count(*)::int AS n FROM analitica.proveedor p ${where}`, params),
    consultarUna<{ n: number; actos: number; monto: N }>(
      `SELECT count(*)::int AS n, sum(actos)::int AS actos, sum(monto_aprox) FILTER (WHERE NOT web.monto_dudoso(monto_aprox, 'ARS')) AS monto FROM analitica.pendientes_cuit`,
    ),
  ]);
  return { filas, total: total?.n ?? 0, pendientes: pendientes ?? { n: 0, actos: 0, monto: null } };
});

export type Empresa = {
  cuit: string;
  razon_social: string | null;
  tipo_societario: string | null;
  fecha_contrato_social: string | null;
  dom_fiscal: string | null;
  fuente: string | null;
  actualizado_en: string | null;
};

export const obtenerProveedor = cacheado("proveedor", async (cuit: string) => {
  const [empresa, resumen, presentaciones, nombres] = await Promise.all([
    consultarUna<Empresa>(
      `SELECT cuit::text, razon_social, tipo_societario, fecha_contrato_social::text, dom_fiscal, fuente, actualizado_en::text
       FROM ref.empresa WHERE cuit = $1::bigint`,
      [cuit],
    ),
    consultarUna<ProveedorFila & { procesos_monto_no_asignable: number }>(
      `SELECT cuit::text, razon_social, tipo_societario, procesos_ganados::int, organismos::int, monto_nominal_ars, pct_oferta_unica,
              pct_excepcion, primera::text, ultima::text, procesos_monto_no_asignable::int
       FROM analitica.proveedor WHERE cuit = $1::bigint`,
      [cuit],
    ),
    consultarUna<{ actos: number; procesos: number; ofertas: number; desestimadas: number }>(
      `SELECT count(DISTINCT af.id_norma)::int AS actos, count(DISTINCT a.codigo_proceso)::int AS procesos,
              count(DISTINCT a.codigo_proceso) FILTER (WHERE af.rol IN ('oferente','desestimada','adjudicada','preadjudicada'))::int AS ofertas,
              count(DISTINCT a.codigo_proceso) FILTER (WHERE af.rol = 'desestimada')::int AS desestimadas
       FROM bo.acto_firma af JOIN analitica.acto_v a USING (id_norma) WHERE af.cuit = $1::bigint`,
      [cuit],
    ),
    consultar<{ nombre_raw: string; n: number }>(
      `SELECT nombre_raw, count(*)::int AS n FROM bo.acto_firma WHERE cuit = $1::bigint GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
      [cuit],
    ),
  ]);
  if (!empresa && !resumen && (presentaciones?.actos ?? 0) === 0) return null;
  const [anios, organismos, historial, senales, concentracion, domicilio, unicas] = await Promise.all([
    consultar<{ anio: number; monto: N; n: number }>(
      `SELECT anio, sum(monto_asignado) FILTER (WHERE moneda = 'ARS' AND NOT web.monto_dudoso(monto_asignado, 'ARS')) AS monto, count(*)::int AS n
       FROM analitica.ganador WHERE cuit = $1::bigint GROUP BY anio ORDER BY anio`,
      [cuit],
    ),
    consultar<{ id: string; nombre: string | null; presento: number; gano: number }>(
      `WITH pres AS (
         SELECT a.organismo_id AS id, a.organismo, a.codigo_proceso FROM bo.acto_firma af JOIN analitica.acto_v a USING (id_norma)
         WHERE af.cuit = $1::bigint AND a.codigo_proceso IS NOT NULL
       ), gan AS (SELECT organismo_id AS id, codigo_proceso FROM analitica.ganador WHERE cuit = $1::bigint)
       SELECT p.id, mode() WITHIN GROUP (ORDER BY p.organismo) AS nombre, count(DISTINCT p.codigo_proceso)::int AS presento,
              (SELECT count(DISTINCT g.codigo_proceso)::int FROM gan g WHERE g.id = p.id) AS gano
       FROM pres p GROUP BY p.id ORDER BY 4 DESC, 3 DESC LIMIT 12`,
      [cuit],
    ),
    consultar<{
      codigo_proceso: string; etapa: string; fecha_publicacion: string; organismo: string | null; organismo_id: string | null;
      objeto: string | null; monto_asignado: N; moneda: string | null; monto_no_asignable: boolean; n_ofertas: number | null;
      unica_oferta: boolean | null; url_norma: string | null; monto_dudoso: boolean;
    }>(
      `SELECT g.codigo_proceso, g.etapa, g.fecha_publicacion::text, g.organismo, g.organismo_id, p.objeto, g.monto_asignado, g.moneda,
              g.monto_no_asignable, p.n_ofertas, p.unica_oferta, n.url_norma, web.monto_dudoso(g.monto_asignado, g.moneda) AS monto_dudoso
       FROM analitica.ganador g LEFT JOIN analitica.proceso p USING (codigo_proceso) LEFT JOIN bo.norma n ON n.id_norma = g.id_norma
       WHERE g.cuit = $1::bigint ORDER BY g.fecha_publicacion DESC, g.codigo_proceso LIMIT 30`,
      [cuit],
    ),
    consultar<CasoSenal>(
      `${SELECT_CASO}
       WHERE s.tipo IN ('empresa-nueva','fraccionamiento') AND s.cuit = $1::bigint
          OR s.tipo = 'domicilio-compartido' AND ($1::bigint::text = s.detalle->>'cuit_1' OR $1::bigint::text = s.detalle->>'cuit_2')
       ORDER BY s.fecha DESC`,
      [cuit],
    ),
    consultar<{ organismo_id: string; organismo: string | null; anio: number; hhi: N; pct_principal: N; monto_total: N }>(
      `SELECT organismo_id, organismo, anio, hhi, pct_principal, monto_total FROM analitica.s_concentracion
       WHERE cuit_principal = $1::bigint ORDER BY pct_principal DESC NULLS LAST LIMIT 5`,
      [cuit],
    ),
    consultar<{ cuit: string; razon_social: string | null; fecha_contrato_social: string | null; procesos: string[] }>(
      `SELECT CASE WHEN d.cuit_1 = $1::bigint THEN d.cuit_2 ELSE d.cuit_1 END::text AS cuit,
              CASE WHEN d.cuit_1 = $1::bigint THEN d.firma_2 ELSE d.firma_1 END AS razon_social,
              e.fecha_contrato_social::text, json_agg(DISTINCT d.codigo_proceso) AS procesos
       FROM analitica.s_domicilio_compartido d
       LEFT JOIN ref.empresa e ON e.cuit = CASE WHEN d.cuit_1 = $1::bigint THEN d.cuit_2 ELSE d.cuit_1 END
       WHERE $1::bigint IN (d.cuit_1, d.cuit_2) GROUP BY 1, 2, 3`,
      [cuit],
    ),
    consultarUna<{ n: number }>(
      `SELECT count(DISTINCT g.codigo_proceso)::int AS n FROM analitica.ganador g JOIN analitica.proceso p USING (codigo_proceso)
       WHERE g.cuit = $1::bigint AND p.unica_oferta`,
      [cuit],
    ),
  ]);
  return {
    empresa: empresa ?? null,
    resumen: resumen ?? null,
    presentaciones: presentaciones ?? { actos: 0, procesos: 0, ofertas: 0, desestimadas: 0 },
    nombres,
    anios,
    organismos,
    historial,
    senales,
    concentracion,
    domicilio,
    unicas: unicas?.n ?? 0,
  };
});

// ---------------------------------------------------------------------
// Organismos
// ---------------------------------------------------------------------
export type OrganismoFila = { id: string; nombre: string | null; procesos: number; monto: N; ultima: string | null; nombres: number };

export const listarOrganismos = cacheado("organismos", async (q: string, orden: string) => {
  const params: unknown[] = [];
  let having = "";
  if (q.trim()) {
    params.push("%" + q.trim().replace(/[%_\\]/g, "\\$&") + "%");
    having = `HAVING bool_or(organismo ILIKE $1) OR organismo_id ILIKE $1`;
  }
  const ord = orden === "nombre" ? "nombre ASC" : orden === "procesos" ? "procesos DESC" : "monto DESC NULLS LAST";
  return consultar<OrganismoFila>(
    `SELECT organismo_id AS id, mode() WITHIN GROUP (ORDER BY organismo) AS nombre, count(*)::int AS procesos,
            sum(monto_adjudicado) FILTER (WHERE moneda_adjudicado = 'ARS' AND NOT web.monto_dudoso(monto_adjudicado, 'ARS')) AS monto,
            greatest(max(fecha_adjudicacion), max(fecha_preadjudicacion), max(fecha_llamado))::text AS ultima,
            count(DISTINCT organismo)::int AS nombres
     FROM analitica.proceso WHERE organismo_id IS NOT NULL
     GROUP BY organismo_id ${having} ORDER BY ${ord}, id`,
    params,
  );
});

export const obtenerOrganismo = cacheado("organismo", async (id: string, anioPedido: number | null) => {
  const nombres = await consultar<{ organismo: string | null; n: number; desde: string; hasta: string }>(
    `SELECT organismo, count(*)::int AS n, min(fecha_publicacion)::text AS desde, max(fecha_publicacion)::text AS hasta
     FROM analitica.acto_v WHERE organismo_id = $1 GROUP BY 1 ORDER BY 2 DESC`,
    [id],
  );
  if (nombres.length === 0) return null;
  const anios = await consultar<{ anio: number; monto: N; procesos: number }>(
    `SELECT extract(year FROM fecha_adjudicacion)::int AS anio,
            sum(monto_adjudicado) FILTER (WHERE moneda_adjudicado = 'ARS' AND NOT web.monto_dudoso(monto_adjudicado, 'ARS')) AS monto,
            count(*)::int AS procesos
     FROM analitica.proceso WHERE organismo_id = $1 AND fecha_adjudicacion IS NOT NULL GROUP BY 1 ORDER BY 1`,
    [id],
  );
  const conDatos = anios.map((a) => a.anio);
  const anio = anioPedido && conDatos.includes(anioPedido) ? anioPedido : (conDatos.at(-1) ?? null);
  const [hhi, proveedores, totalAnio, procedimiento, ciudad, fracc, modif, resumen] = await Promise.all([
    consultarUna<{ hhi: N; proveedores: number; pct_principal: N; cuit_principal: string | null; monto_total: N }>(
      `SELECT hhi, proveedores::int, pct_principal, cuit_principal::text, monto_total FROM analitica.s_concentracion
       WHERE organismo_id = $1 AND anio = $2`,
      [id, anio],
    ),
    consultar<{ cuit: string; nombre: string | null; monto: N; pct: N; n: number }>(
      `WITH b AS (
         SELECT cuit, monto_asignado AS monto, codigo_proceso FROM analitica.ganador
         WHERE organismo_id = $1 AND anio = $2 AND moneda = 'ARS' AND monto_asignado IS NOT NULL
           AND NOT web.monto_dudoso(monto_asignado, 'ARS')
       ), t AS (SELECT sum(monto) AS total FROM b)
       SELECT b.cuit::text, e.razon_social AS nombre, sum(b.monto) AS monto, count(DISTINCT b.codigo_proceso)::int AS n,
              round(100 * sum(b.monto) / nullif((SELECT total FROM t), 0), 1) AS pct
       FROM b LEFT JOIN ref.empresa e ON e.cuit = b.cuit WHERE b.cuit IS NOT NULL
       GROUP BY b.cuit, e.razon_social ORDER BY sum(b.monto) DESC LIMIT 8`,
      [id, anio],
    ),
    consultarUna<{ total: N; sin_cuit: N; proveedores: number }>(
      `SELECT sum(monto_asignado) AS total, sum(monto_asignado) FILTER (WHERE cuit IS NULL) AS sin_cuit,
              count(DISTINCT cuit)::int AS proveedores
       FROM analitica.ganador WHERE organismo_id = $1 AND anio = $2 AND moneda = 'ARS' AND monto_asignado IS NOT NULL
         AND NOT web.monto_dudoso(monto_asignado, 'ARS')`,
      [id, anio],
    ),
    consultarUna<{ procesos: number; directas: number; menores: number; pct_excepcion_cantidad: N; pct_excepcion_monto_nominal: N }>(
      `SELECT procesos::int, directas::int, menores::int, pct_excepcion_cantidad, pct_excepcion_monto_nominal
       FROM analitica.s_procedimiento WHERE organismo_id = $1 AND anio = $2`,
      [id, anio],
    ),
    consultarUna<{ pct: N }>(
      `SELECT round(100.0 * sum(directas + menores) / nullif(sum(procesos), 0), 1) AS pct FROM analitica.s_procedimiento WHERE anio = $1`,
      [anio],
    ),
    consultarUna<{ casos: number; proveedores: number }>(
      `SELECT count(*)::int AS casos, count(DISTINCT cuit)::int AS proveedores FROM web.senal_caso
       WHERE tipo = 'fraccionamiento' AND organismo_id = $1`,
      [id],
    ),
    consultar<CasoSenal>(`${SELECT_CASO} WHERE s.tipo = 'modificaciones' AND s.organismo_id = $1 ORDER BY s.fecha DESC LIMIT 8`, [id]),
    consultarUna<{ procesos: number; monto: N; unica: number; con_dato: number }>(
      `SELECT count(*)::int AS procesos,
              sum(monto_adjudicado) FILTER (WHERE moneda_adjudicado = 'ARS' AND NOT web.monto_dudoso(monto_adjudicado, 'ARS')) AS monto,
              count(*) FILTER (WHERE unica_oferta)::int AS unica, count(*) FILTER (WHERE unica_oferta IS NOT NULL)::int AS con_dato
       FROM analitica.proceso WHERE organismo_id = $1`,
      [id],
    ),
  ]);
  return {
    nombres, anios, anio, hhi: hhi ?? null, proveedores, totalAnio: totalAnio ?? null, procedimiento: procedimiento ?? null,
    ciudad: ciudad?.pct ?? null, fracc: fracc ?? { casos: 0, proveedores: 0 }, modif, resumen: resumen ?? null,
  };
});

// ---------------------------------------------------------------------
// Señales
// ---------------------------------------------------------------------
export const contarSenales = cacheado("senales-conteo", async () => {
  const filas = await consultar<{ tipo: string; n: number }>(
    `SELECT tipo, count(DISTINCT codigo_proceso)::int AS n FROM web.senal_caso GROUP BY tipo
     UNION ALL SELECT 'concentracion', count(*)::int FROM analitica.s_concentracion WHERE hhi >= 2500`,
  );
  return Object.fromEntries(filas.map((f) => [f.tipo, f.n])) as Record<string, number>;
});

export const listarCasos = cacheado(
  "senales-casos",
  async (tipo: string, org: string | null, anio: number | null, orden: string, pagina: number) => {
    const params: unknown[] = [tipo];
    let where = `WHERE s.tipo = $1`;
    if (org) {
      params.push(org);
      where += ` AND s.organismo_id = $${params.length}`;
    }
    if (anio) {
      params.push(anio);
      where += ` AND extract(year FROM s.fecha) = $${params.length}`;
    }
    const ord =
      orden === "monto"
        ? "CASE WHEN web.monto_dudoso(s.monto, s.moneda) THEN NULL ELSE s.monto END DESC NULLS LAST, s.fecha DESC"
        : "s.fecha DESC NULLS LAST, s.codigo_proceso";
    const off = (Math.max(1, pagina) - 1) * POR_PAGINA_LISTA;
    const [filas, total] = await Promise.all([
      consultar<CasoSenal>(`${SELECT_CASO} ${where} ORDER BY ${ord} LIMIT ${POR_PAGINA_LISTA} OFFSET ${off}`, params),
      consultarUna<{ n: number }>(`SELECT count(*)::int AS n FROM web.senal_caso s ${where}`, params),
    ]);
    return { filas, total: total?.n ?? 0 };
  },
);

export const listarConcentracion = cacheado("senales-hhi", async (anio: number | null, pagina: number) => {
  const params: unknown[] = [];
  let where = "WHERE c.hhi >= 2500";
  if (anio) {
    params.push(anio);
    where += ` AND c.anio = $1`;
  }
  const off = (Math.max(1, pagina) - 1) * POR_PAGINA_LISTA;
  const [filas, total] = await Promise.all([
    consultar<{ organismo_id: string; organismo: string | null; anio: number; hhi: N; proveedores: number; cuit_principal: string | null; pct_principal: N; monto_total: N; razon_social: string | null }>(
      `SELECT c.organismo_id, c.organismo, c.anio, c.hhi, c.proveedores::int, c.cuit_principal::text, c.pct_principal, c.monto_total,
              e.razon_social
       FROM analitica.s_concentracion c LEFT JOIN ref.empresa e ON e.cuit = c.cuit_principal
       ${where} ORDER BY c.anio DESC, c.monto_total DESC NULLS LAST LIMIT ${POR_PAGINA_LISTA} OFFSET ${off}`,
      params,
    ),
    consultarUna<{ n: number }>(`SELECT count(*)::int AS n FROM analitica.s_concentracion c ${where}`, params),
  ]);
  return { filas, total: total?.n ?? 0 };
});

export const aniosConSenales = cacheado("senales-anios", async () =>
  (await consultar<{ anio: number }>(`SELECT DISTINCT extract(year FROM fecha)::int AS anio FROM web.senal_caso WHERE fecha IS NOT NULL ORDER BY 1 DESC`)).map((r) => r.anio),
);

// ---------------------------------------------------------------------
// Metodología
// ---------------------------------------------------------------------
export const obtenerCalidad = cacheado("calidad", async () => {
  const [parser, docs, resol, llm, pend, control, padron, conf, anual] = await Promise.all([
    consultarUna<{ actos: number; alta: number; media: number; baja: number; con_codigo: number; con_monto: number; conflicto: number }>(
      `SELECT count(*)::int AS actos, count(*) FILTER (WHERE confianza = 'alta')::int AS alta,
              count(*) FILTER (WHERE confianza = 'media')::int AS media, count(*) FILTER (WHERE confianza = 'baja')::int AS baja,
              count(*) FILTER (WHERE codigo_proceso IS NOT NULL)::int AS con_codigo, count(*) FILTER (WHERE monto_total IS NOT NULL)::int AS con_monto,
              count(*) FILTER (WHERE etapa_conflicto)::int AS conflicto
       FROM analitica.acto_v`,
    ),
    consultar<{ estado: string; documentos: number }>(
      `SELECT estado, sum(documentos)::int AS documentos FROM analitica.calidad_documentos GROUP BY 1 ORDER BY 2 DESC`,
    ),
    consultar<{ resolucion: string; firmas: number }>(
      `SELECT resolucion, sum(firmas)::int AS firmas FROM analitica.calidad_resolucion GROUP BY 1 ORDER BY 2 DESC`,
    ),
    consultarUna<{ actos: number; con_llm: number; codigo: number; monto: number; etapa: number }>(
      `SELECT coalesce(sum(actos), 0)::int AS actos, coalesce(sum(con_llm), 0)::int AS con_llm,
              coalesce(sum(codigo_completado), 0)::int AS codigo, coalesce(sum(monto_completado), 0)::int AS monto,
              coalesce(sum(etapa_completada), 0)::int AS etapa
       FROM analitica.calidad_llm`,
    ),
    consultarUna<{ n: number; actos: number; monto: N }>(
      `SELECT count(*)::int AS n, coalesce(sum(actos), 0)::int AS actos, sum(monto_aprox) FILTER (WHERE NOT web.monto_dudoso(monto_aprox, 'ARS')) AS monto FROM analitica.pendientes_cuit`,
    ),
    consultarUna<{ n: number }>(`SELECT count(*)::int AS n FROM analitica.control_montos`),
    consultarUna<{ n: number }>(`SELECT count(*)::int AS n FROM ref.empresa`),
    consultar<{ anio: number; actos: number; pct_alta: N; pct_baja: N; pct_con_monto: N }>(
      `SELECT anio, sum(actos)::int AS actos,
              round(sum(actos * pct_alta) / nullif(sum(actos), 0), 1) AS pct_alta,
              round(sum(actos * pct_baja) / nullif(sum(actos), 0), 1) AS pct_baja,
              round(sum(actos * pct_con_monto) / nullif(sum(actos), 0), 1) AS pct_con_monto
       FROM analitica.calidad_parser GROUP BY anio ORDER BY anio`,
    ),
    consultar<{ anio: number; licitaciones: number; con_texto: number }>(
      `SELECT extract(year FROM n.fecha_publicacion)::int AS anio, count(*)::int AS licitaciones,
              count(*) FILTER (WHERE d.estado = 'ok')::int AS con_texto
       FROM bo.norma n LEFT JOIN bo.documento d USING (id_norma) WHERE n.seccion = 'Licitaciones' GROUP BY 1 ORDER BY 1`,
    ),
  ]);
  return {
    parser: parser ?? { actos: 0, alta: 0, media: 0, baja: 0, con_codigo: 0, con_monto: 0, conflicto: 0 },
    docs, resol, llm: llm ?? { actos: 0, con_llm: 0, codigo: 0, monto: 0, etapa: 0 },
    pendientes: pend ?? { n: 0, actos: 0, monto: null }, controlMontos: control?.n ?? 0, padron: padron?.n ?? 0,
    porAnio: conf, licitacionesPorAnio: anual,
  };
});

// ---------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------
export const obtenerClavesSitemap = cacheado("sitemap", async () => {
  const [procesos, proveedores, organismos] = await Promise.all([
    consultar<{ k: string; f: string | null }>(
      `SELECT codigo_proceso AS k, greatest(fecha_adjudicacion, fecha_preadjudicacion, fecha_llamado)::text AS f FROM analitica.proceso`,
    ),
    consultar<{ k: string; f: string | null }>(`SELECT cuit::text AS k, ultima::text AS f FROM analitica.proveedor`),
    consultar<{ k: string }>(`SELECT DISTINCT organismo_id AS k FROM analitica.proceso WHERE organismo_id IS NOT NULL`),
  ]);
  return { procesos, proveedores, organismos };
});

export type { Fila };
