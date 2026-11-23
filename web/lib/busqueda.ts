// Buscador de procesos: filtros <-> query string <-> SQL parametrizado.
// Funciones puras (sin acceso a la base) para poder testearlas.

import { GRUPOS_ETAPA, GRUPOS_PROC } from "./catalogo";
import { parsearCuit } from "./formato";

export const POR_PAGINA = 25;
export const MAX_EXPORTAR = 10_000;

export type Orden = "fecha" | "monto";

export type Filtros = {
  q: string;
  desde: string | null; // aaaa-mm-dd
  hasta: string | null;
  org: string | null;
  cuit: string | null;
  etapas: string[]; // ids de GRUPOS_ETAPA; vacío = todas
  procs: string[]; // ids de GRUPOS_PROC + "otros"; vacío = todos
  moneda: "ARS" | "USD" | null;
  montoMin: number | null;
  conSenal: boolean;
  senal: string | null;
  conf: string[]; // alta | media | baja; vacío = todas
  orden: Orden;
  pagina: number;
};

export type Params = Record<string, string | string[] | undefined>;

const lista = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : (Array.isArray(v) ? v : [v]).flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);

const uno = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? "")).trim();

/** Acepta aaaa-mm-dd o dd/mm/aaaa; devuelve aaaa-mm-dd o null. */
export function parsearFecha(v: string): string | null {
  let a: number, m: number, d: number;
  let r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (r) {
    [a, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  } else {
    r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
    if (!r) return null;
    [d, m, a] = [Number(r[1]), Number(r[2]), Number(r[3])];
  }
  const dt = new Date(Date.UTC(a, m - 1, d));
  if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${a}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "1.500.000" / "1500000" / "$ 1,5" -> número o null */
export function parsearMonto(v: string): number | null {
  const s = v.replace(/[$\s]/g, "").replace(/\./g, "").replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const ETAPAS_VALIDAS: Set<string> = new Set(GRUPOS_ETAPA.map((g) => g.id));
const PROCS_VALIDOS: Set<string> = new Set([...GRUPOS_PROC.map((g) => g.id), "otros"]);
const CONF_VALIDAS = new Set(["alta", "media", "baja"]);

export function parsearFiltros(p: Params): Filtros {
  const etapas = lista(p.etapa).filter((e) => ETAPAS_VALIDAS.has(e));
  const procs = lista(p.proc).filter((e) => PROCS_VALIDOS.has(e));
  const conf = lista(p.conf).filter((e) => CONF_VALIDAS.has(e));
  const moneda = uno(p.moneda).toUpperCase();
  const pagina = Math.max(1, Math.min(10_000, Number.parseInt(uno(p.pagina), 10) || 1));
  return {
    q: uno(p.q).slice(0, 200),
    desde: parsearFecha(uno(p.desde)),
    hasta: parsearFecha(uno(p.hasta)),
    org: uno(p.org) || null,
    cuit: parsearCuit(uno(p.cuit)),
    // marcar todas las opciones equivale a no filtrar
    etapas: etapas.length === ETAPAS_VALIDAS.size ? [] : [...new Set(etapas)],
    procs: procs.length === PROCS_VALIDOS.size ? [] : [...new Set(procs)],
    moneda: moneda === "ARS" || moneda === "USD" ? moneda : null,
    montoMin: parsearMonto(uno(p.min)),
    conSenal: uno(p.senales) === "1",
    senal: uno(p.senal) || null,
    conf: conf.length === CONF_VALIDAS.size ? [] : [...new Set(conf)],
    orden: uno(p.orden) === "monto" ? "monto" : "fecha",
    pagina,
  };
}

/** Filtros -> query string (sin "?"), omitiendo los valores por defecto. */
export function aQuery(f: Partial<Filtros>, cambios: Partial<Filtros> = {}): string {
  const x = { ...f, ...cambios };
  const u = new URLSearchParams();
  if (x.q) u.set("q", x.q);
  if (x.desde) u.set("desde", x.desde);
  if (x.hasta) u.set("hasta", x.hasta);
  if (x.org) u.set("org", x.org);
  if (x.cuit) u.set("cuit", x.cuit);
  for (const e of x.etapas ?? []) u.append("etapa", e);
  for (const e of x.procs ?? []) u.append("proc", e);
  if (x.moneda) u.set("moneda", x.moneda);
  if (x.montoMin !== null && x.montoMin !== undefined) u.set("min", String(x.montoMin));
  if (x.conSenal) u.set("senales", "1");
  if (x.senal) u.set("senal", x.senal);
  for (const e of x.conf ?? []) u.append("conf", e);
  if (x.orden && x.orden !== "fecha") u.set("orden", x.orden);
  if (x.pagina && x.pagina > 1) u.set("pagina", String(x.pagina));
  return u.toString();
}

export function hayFiltros(f: Filtros): boolean {
  return Boolean(
    f.desde || f.hasta || f.org || f.cuit || f.etapas.length || f.procs.length || f.moneda ||
      f.montoMin !== null || f.conSenal || f.senal || f.conf.length,
  );
}

export type Consulta = { where: string; params: unknown[] };

const PATRON_CODIGO = /^\d{1,5}-\d{1,5}-[A-Z]{3}\d{2}$|^\d+\/[A-Z]+\/\d{2,4}$/i;
const PATRON_EXPEDIENTE = /^EX-\d{4}-/i;

/**
 * Arma el WHERE sobre web.acto_busqueda (alias `b`). Todos los valores van
 * como parámetros posicionales; el texto SQL solo depende de qué filtros hay.
 */
// Las listas viajan como texto separado por comas (valores de listas blancas, sin comas):
// el driver no serializa arrays sin consultar pg_type.
export function construirWhere(f: Filtros): Consulta {
  const cond: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  const q = f.q.trim();
  if (q) {
    const cuit = parsearCuit(q);
    if (cuit) {
      cond.push(`b.cuits @> array[${p(cuit)}::bigint]`);
    } else if (PATRON_CODIGO.test(q)) {
      cond.push(`upper(b.codigo_proceso) = upper(${p(q)})`);
    } else if (PATRON_EXPEDIENTE.test(q)) {
      cond.push(`b.expediente ILIKE ${p(q.replace(/[%_\\]/g, "\\$&") + "%")}`);
    } else {
      const tq = p(q);
      const like = p("%" + q.replace(/[%_\\]/g, "\\$&") + "%");
      cond.push(
        `(b.doc @@ websearch_to_tsquery('spanish', ${tq}) OR b.codigo_proceso ILIKE ${like} OR b.expediente ILIKE ${like})`,
      );
    }
  }
  if (f.desde) cond.push(`b.fecha_publicacion >= ${p(f.desde)}::date`);
  if (f.hasta) cond.push(`b.fecha_publicacion <= ${p(f.hasta)}::date`);
  if (f.org) cond.push(`b.organismo_id = ${p(f.org)}`);
  if (f.cuit) cond.push(`b.cuits @> array[${p(f.cuit)}::bigint]`);
  if (f.etapas.length) {
    const etapas = GRUPOS_ETAPA.filter((g) => f.etapas.includes(g.id)).flatMap((g) => [...g.etapas]);
    const incluyeNulas = f.etapas.includes("otras");
    cond.push(`(b.etapa = ANY(string_to_array(${p(etapas.join(","))}, ','))${incluyeNulas ? " OR b.etapa IS NULL" : ""})`);
  }
  if (f.procs.length) {
    const tipos = GRUPOS_PROC.filter((g) => f.procs.includes(g.id)).flatMap((g) => [...g.tipos]);
    const todos = GRUPOS_PROC.flatMap((g) => [...g.tipos]);
    const partes: string[] = [];
    if (tipos.length) partes.push(`b.tipo_proc = ANY(string_to_array(${p(tipos.join(","))}, ','))`);
    if (f.procs.includes("otros")) partes.push(`(b.tipo_proc IS NULL OR NOT (b.tipo_proc = ANY(string_to_array(${p(todos.join(","))}, ','))))`);
    cond.push(`(${partes.join(" OR ")})`);
  }
  if (f.moneda) cond.push(`b.moneda = ${p(f.moneda)}`);
  if (f.montoMin !== null) cond.push(`b.monto_total >= ${p(f.montoMin)}::numeric AND NOT b.monto_dudoso`);
  if (f.conSenal) cond.push(`cardinality(b.senales) > 0`);
  if (f.senal) cond.push(`${p(f.senal)} = ANY(b.senales)`);
  if (f.conf.length) cond.push(`b.confianza = ANY(string_to_array(${p(f.conf.join(","))}, ','))`);

  return { where: cond.length ? "WHERE " + cond.join(" AND ") : "", params };
}

export function construirOrden(f: Filtros): string {
  return f.orden === "monto"
    ? "ORDER BY (CASE WHEN b.monto_dudoso THEN NULL ELSE b.monto_total END) DESC NULLS LAST, b.fecha_publicacion DESC, b.id_norma DESC"
    : "ORDER BY b.fecha_publicacion DESC, b.id_norma DESC";
}

export const COLUMNAS =
  "b.id_norma, b.codigo_proceso, b.codigo_fuente, b.fecha_publicacion, b.etapa, b.etapa_fuente, b.tipo_proc, b.organismo, b.organismo_id, b.objeto, b.expediente, b.monto_total, b.moneda, b.monto_origen, b.monto_fuente, b.monto_dudoso, b.confianza, b.url_norma, b.nombre_norma, to_json(b.senales) AS senales";

export function consultaPagina(f: Filtros): { texto: string; params: unknown[] } {
  const { where, params } = construirWhere(f);
  const off = (f.pagina - 1) * POR_PAGINA;
  return {
    texto: `SELECT ${COLUMNAS} FROM web.acto_busqueda b ${where} ${construirOrden(f)} LIMIT ${POR_PAGINA} OFFSET ${off}`,
    params,
  };
}

export function consultaResumen(f: Filtros): { texto: string; params: unknown[] } {
  const { where, params } = construirWhere(f);
  return {
    texto: `SELECT count(*)::int AS actos, count(DISTINCT b.codigo_proceso)::int AS procesos,
      sum(b.monto_total) FILTER (WHERE b.etapa = 'adjudicacion' AND b.moneda = 'ARS' AND NOT b.monto_dudoso) AS ars,
      sum(b.monto_total) FILTER (WHERE b.etapa = 'adjudicacion' AND b.moneda = 'USD' AND NOT b.monto_dudoso) AS usd,
      count(*) FILTER (WHERE b.etapa = 'adjudicacion')::int AS adjudicaciones,
      count(*) FILTER (WHERE b.etapa = 'adjudicacion' AND (b.monto_total IS NULL OR b.monto_dudoso))::int AS adj_sin_monto
      FROM web.acto_busqueda b ${where}`,
    params,
  };
}

export function consultaExportar(f: Filtros): { texto: string; params: unknown[] } {
  const { where, params } = construirWhere(f);
  return {
    texto: `SELECT ${COLUMNAS} FROM web.acto_busqueda b ${where} ${construirOrden(f)} LIMIT ${MAX_EXPORTAR}`,
    params,
  };
}

/** Celda CSV (RFC 4180) con defensa contra inyección de fórmulas en planillas. */
export function celdaCsv(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = Array.isArray(v) ? v.join("|") : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
