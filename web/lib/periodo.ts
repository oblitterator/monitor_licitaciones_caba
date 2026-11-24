// Período del tablero: último mes con datos, un año o un rango.

import { parsearFecha, type Params } from "./busqueda";
import { fecha, mesLargo, nombreMes } from "./formato";

export type Periodo = {
  tipo: "mes" | "anio" | "rango";
  desde: string; // aaaa-mm-dd inclusive
  hasta: string; // aaaa-mm-dd inclusive
  anio: number | null;
  etiqueta: string;
};

const uno = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

function finDeMes(a: number, m: number): string {
  const d = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return `${a}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * `ultima` es la última fecha con actos en la base (aaaa-mm-dd); `primera`, la primera.
 * Por defecto: el año de la última fecha.
 */
export function parsearPeriodo(p: Params, primera: string, ultima: string): Periodo {
  const tipo = uno(p.periodo);
  const aUlt = Number(ultima.slice(0, 4));
  const mUlt = Number(ultima.slice(5, 7));
  const aPri = Number(primera.slice(0, 4));

  if (tipo === "mes") {
    const r = /^(\d{4})-(\d{2})$/.exec(uno(p.mes));
    const a = r ? Number(r[1]) : aUlt;
    const m = r && Number(r[2]) >= 1 && Number(r[2]) <= 12 ? Number(r[2]) : mUlt;
    const desde = `${a}-${String(m).padStart(2, "0")}-01`;
    return { tipo: "mes", desde, hasta: finDeMes(a, m), anio: null, etiqueta: mesLargo(desde) };
  }
  if (tipo === "rango") {
    let desde = parsearFecha(uno(p.desde)) ?? primera;
    let hasta = parsearFecha(uno(p.hasta)) ?? ultima;
    if (desde > hasta) [desde, hasta] = [hasta, desde];
    return { tipo: "rango", desde, hasta, anio: null, etiqueta: `del ${fecha(desde)} al ${fecha(hasta)}` };
  }
  const pedido = Number.parseInt(uno(p.anio), 10);
  const anio = Number.isFinite(pedido) && pedido >= aPri && pedido <= aUlt ? pedido : aUlt;
  return {
    tipo: "anio",
    desde: `${anio}-01-01`,
    hasta: `${anio}-12-31`,
    anio,
    etiqueta: etiquetaAnio(anio, primera, ultima),
  };
}

/** "enero a marzo de 2024" si el año está incompleto en la base; "2023" si no. */
export function etiquetaAnio(anio: number, primera: string, ultima: string): string {
  const aPri = Number(primera.slice(0, 4));
  const aUlt = Number(ultima.slice(0, 4));
  const mIni = anio === aPri ? Number(primera.slice(5, 7)) : 1;
  const mFin = anio === aUlt ? Number(ultima.slice(5, 7)) : 12;
  if (mIni === 1 && mFin === 12) return String(anio);
  if (mIni === mFin) return `${nombreMes(mIni)} de ${anio}`;
  return `${nombreMes(mIni)} a ${nombreMes(mFin)} de ${anio}`;
}

/** Query string para un enlace de período */
export function queryPeriodo(p: Partial<Periodo> & { tipo: Periodo["tipo"] }): string {
  const u = new URLSearchParams();
  if (p.tipo === "anio" && p.anio) u.set("anio", String(p.anio));
  if (p.tipo === "mes") {
    u.set("periodo", "mes");
    if (p.desde) u.set("mes", p.desde.slice(0, 7));
  }
  if (p.tipo === "rango") {
    u.set("periodo", "rango");
    if (p.desde) u.set("desde", p.desde);
    if (p.hasta) u.set("hasta", p.hasta);
  }
  const s = u.toString();
  return s ? "?" + s : "";
}
