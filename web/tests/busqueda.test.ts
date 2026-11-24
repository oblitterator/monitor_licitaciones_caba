import { describe, expect, it } from "vitest";
import { aQuery, celdaCsv, consultaPagina, construirWhere, parsearFecha, parsearFiltros, parsearMonto, POR_PAGINA } from "@/lib/busqueda";

describe("parsearFiltros", () => {
  it("valores por defecto", () => {
    const f = parsearFiltros({});
    expect(f).toMatchObject({ q: "", desde: null, etapas: [], procs: [], conf: [], orden: "fecha", pagina: 1, conSenal: false });
  });
  it("lee listas repetidas o separadas por coma y descarta valores desconocidos", () => {
    const f = parsearFiltros({ etapa: ["llamado", "adjudicacion,nada"], conf: "alta", proc: "CME" });
    expect(f.etapas).toEqual(["llamado", "adjudicacion"]);
    expect(f.conf).toEqual(["alta"]);
    expect(f.procs).toEqual(["CME"]);
  });
  it("marcar todas las opciones equivale a no filtrar", () => {
    const f = parsearFiltros({ conf: ["alta", "media", "baja"] });
    expect(f.conf).toEqual([]);
  });
  it("fechas en los dos formatos y fechas imposibles", () => {
    expect(parsearFecha("31/08/2024")).toBe("2024-08-31");
    expect(parsearFecha("2024-02-30")).toBeNull();
    expect(parsearFiltros({ desde: "01/01/2023", hasta: "basura" })).toMatchObject({ desde: "2023-01-01", hasta: null });
  });
  it("monto mínimo con formato argentino", () => {
    expect(parsearMonto("$ 1.500.000")).toBe(1_500_000);
    expect(parsearMonto("2,5")).toBe(2.5);
    expect(parsearMonto("-3")).toBeNull();
  });
  it("página acotada", () => {
    expect(parsearFiltros({ pagina: "-4" }).pagina).toBe(1);
    expect(parsearFiltros({ pagina: "3" }).pagina).toBe(3);
  });
});

describe("construirWhere", () => {
  it("sin filtros no hay WHERE", () => {
    expect(construirWhere(parsearFiltros({}))).toEqual({ where: "", params: [] });
  });
  it("texto libre usa full-text en castellano y todo va parametrizado", () => {
    const { where, params } = construirWhere(parsearFiltros({ q: "limpieza'; DROP TABLE x; --" }));
    expect(where).toContain("websearch_to_tsquery('spanish', $1)");
    expect(where).not.toContain("DROP");
    expect(params[0]).toBe("limpieza'; DROP TABLE x; --");
  });
  it("un CUIT busca por CUIT exacto", () => {
    const { where, params } = construirWhere(parsearFiltros({ q: "30-70395143-7" }));
    expect(where).toBe("WHERE b.cuits @> array[$1::bigint]");
    expect(params).toEqual(["30703951437"]);
  });
  it("un código de proceso BAC o SIGAF busca por código", () => {
    expect(construirWhere(parsearFiltros({ q: "401-0258-lpu24" })).where).toContain("upper(b.codigo_proceso) = upper($1)");
    expect(construirWhere(parsearFiltros({ q: "5072/SIGAF/20" })).where).toContain("upper(b.codigo_proceso)");
  });
  it("escapa comodines de LIKE en el expediente", () => {
    const { params } = construirWhere(parsearFiltros({ q: "EX-2024-1%" }));
    expect(params[0]).toBe("EX-2024-1\\%%");
  });
  it("combina filtros con parámetros numerados en orden", () => {
    const { where, params } = construirWhere(
      parsearFiltros({ desde: "2023-01-01", org: "401", etapa: ["modificacion"], proc: ["CME", "otros"], senales: "1", conf: ["baja"], moneda: "usd" }),
    );
    expect(where).toContain("b.fecha_publicacion >= $1::date");
    expect(where).toContain("b.organismo_id = $2");
    expect(where).toContain("b.etapa = ANY(string_to_array($3, ','))");
    expect(params[2]).toBe("prorroga,ampliacion,modificacion,rectificacion");
    expect(where).toContain("b.tipo_proc = ANY(string_to_array($4, ','))");
    expect(where).toContain("b.tipo_proc IS NULL OR NOT");
    expect(where).toContain("b.moneda = $6");
    expect(where).toContain("cardinality(b.senales) > 0");
    expect(params.at(-1)).toBe("baja");
  });
  it("'otras' etapas incluye los actos sin etapa", () => {
    expect(construirWhere(parsearFiltros({ etapa: "otras" })).where).toContain("OR b.etapa IS NULL");
  });
});

describe("paginado y orden", () => {
  it("LIMIT y OFFSET según la página", () => {
    const { texto } = consultaPagina(parsearFiltros({ pagina: "3", orden: "monto" }));
    expect(texto).toContain(`LIMIT ${POR_PAGINA} OFFSET ${2 * POR_PAGINA}`);
    expect(texto).toContain("ORDER BY (CASE WHEN b.monto_dudoso");
  });
  it("aQuery omite los valores por defecto y es reversible", () => {
    const f = parsearFiltros({ q: "limpieza", etapa: ["llamado"], orden: "monto", pagina: "2" });
    const qs = aQuery(f);
    expect(qs).toBe("q=limpieza&etapa=llamado&orden=monto&pagina=2");
    const back = parsearFiltros(Object.fromEntries(new URLSearchParams(qs)));
    expect(back).toEqual(f);
    expect(aQuery(f, { pagina: 1, orden: "fecha" })).toBe("q=limpieza&etapa=llamado");
  });
});

describe("CSV", () => {
  it("comillas, separadores y fórmulas", () => {
    expect(celdaCsv('dice "hola", chau')).toBe('"dice ""hola"", chau"');
    expect(celdaCsv("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(celdaCsv("-123.5")).toBe("-123.5");
    expect(celdaCsv(["a", "b"])).toBe("a|b");
    expect(celdaCsv(null)).toBe("");
  });
});
