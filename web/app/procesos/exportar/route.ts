import { consultar } from "@/lib/db";
import { celdaCsv, consultaExportar, parsearFiltros, type Params } from "@/lib/busqueda";
import { etapa, procedimiento } from "@/lib/catalogo";

// CSV de los resultados del buscador (mismos filtros que /procesos, hasta 10.000 filas).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const p: Params = {};
  for (const k of new Set(url.searchParams.keys())) {
    const v = url.searchParams.getAll(k);
    p[k] = v.length > 1 ? v : v[0];
  }
  const f = parsearFiltros(p);
  const { texto, params } = consultaExportar(f);
  const filas = await consultar(texto, params);
  const cols: [string, (r: Record<string, unknown>) => unknown][] = [
    ["fecha_publicacion", (r) => r.fecha_publicacion],
    ["codigo_proceso", (r) => r.codigo_proceso],
    ["etapa", (r) => etapa(r.etapa as string | null)],
    ["procedimiento", (r) => procedimiento(r.tipo_proc as string | null)],
    ["organismo", (r) => r.organismo],
    ["organismo_id", (r) => r.organismo_id],
    ["objeto", (r) => r.objeto],
    ["expediente", (r) => r.expediente],
    ["monto", (r) => r.monto_total],
    ["moneda", (r) => r.moneda],
    ["monto_estimado", (r) => (r.monto_origen === "suma_firmas" ? "si" : "no")],
    ["monto_dudoso", (r) => (r.monto_dudoso ? "si" : "no")],
    ["monto_fuente", (r) => r.monto_fuente],
    ["confianza", (r) => r.confianza],
    ["senales", (r) => r.senales],
    ["url_pdf", (r) => r.url_norma],
    ["id_norma", (r) => r.id_norma],
  ];
  const lineas = [cols.map(([c]) => c).join(",")];
  for (const r of filas) lineas.push(cols.map(([, fn]) => celdaCsv(fn(r))).join(","));
  const hoy = new Date().toISOString().slice(0, 10);
  return new Response("﻿" + lineas.join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="procesos-caba-${hoy}.csv"`,
      "cache-control": "public, max-age=3600",
    },
  });
}
