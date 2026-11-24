// Formato es-AR hecho a mano (no depende del ICU del runtime): punto de miles,
// coma decimal, montos grandes en millones ("$ 1.234,5 M") y fechas dd/mm/aaaa.

export type Numerico = number | string | null | undefined;

export function aNumero(v: Numerico): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 1234567.891 -> "1.234.567,89" con `dec` decimales (redondeo half-up). */
export function numero(v: Numerico, dec = 0): string {
  const n = aNumero(v);
  if (n === null) return "—";
  const neg = n < 0;
  const fijo = Math.abs(n).toFixed(dec);
  const [ent = "0", frac] = fijo.split(".");
  const miles = ent.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (neg ? "−" : "") + miles + (frac ? "," + frac : "");
}

export function entero(v: Numerico): string {
  return numero(v, 0);
}

/** 23.4 -> "23,4 %" */
export function porcentaje(v: Numerico, dec = 1): string {
  const n = aNumero(v);
  return n === null ? "—" : `${numero(n, dec)} %`;
}

/**
 * Monto en pesos o dólares.
 * ARS: >= 1 M se muestra en millones con 1 decimal (o sin decimales desde 1.000 M);
 * debajo, el número entero. USD: siempre el número entero salvo desde 10 M.
 */
export function monto(v: Numerico, moneda: string | null | undefined = "ARS"): string {
  const n = aNumero(v);
  if (n === null) return "Sin monto";
  const signo = n < 0 ? "− " : "";
  const a = Math.abs(n);
  const pref = moneda === "USD" ? "USD" : "$";
  const umbral = moneda === "USD" ? 10_000_000 : 1_000_000;
  if (a >= umbral) {
    const m = a / 1_000_000;
    return `${signo}${pref} ${numero(m, m >= 1000 ? 0 : 1)} M`;
  }
  return `${signo}${pref} ${numero(a, a < 100 && a % 1 !== 0 ? 2 : 0)}`;
}

/** Millones sin prefijo para gráficos: 12345678901 -> "12.346" */
export function millones(v: Numerico): string {
  const n = aNumero(v);
  if (n === null) return "—";
  if (n === 0) return "0";
  const m = n / 1_000_000;
  return numero(m, m < 10 ? 1 : 0);
}

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function partes(v: string | null | undefined): [number, number, number] | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** "2024-03-14" -> "14/03/2024" */
export function fecha(v: string | null | undefined): string {
  const p = partes(v);
  if (!p) return "Sin fecha";
  const [a, m, d] = p;
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${a}`;
}

/** "2024-03-14" -> "14/03/24" (para etiquetas de fuente: "BO 14/03/24") */
export function fechaCorta(v: string | null | undefined): string {
  const f = fecha(v);
  return f === "Sin fecha" ? f : f.slice(0, 6) + f.slice(8);
}

/** "2024-03-14" -> "jueves 14/03/2024" */
export function fechaConDia(v: string | null | undefined): string {
  const p = partes(v);
  if (!p) return "Sin fecha";
  const [a, m, d] = p;
  const dia = DIAS[new Date(Date.UTC(a, m - 1, d)).getUTCDay()];
  return `${dia} ${fecha(v)}`;
}

/** "2024-03-01" -> "03/2024" */
export function mesAnio(v: string | null | undefined): string {
  const p = partes(v);
  return p ? `${String(p[1]).padStart(2, "0")}/${p[0]}` : "—";
}

/** "2024-03-01" -> "marzo de 2024" */
export function mesLargo(v: string | null | undefined): string {
  const p = partes(v);
  return p ? `${MESES[p[1] - 1]} de ${p[0]}` : "—";
}

export function nombreMes(m: number): string {
  return MESES[m - 1] ?? "";
}

/** 30712345678 -> "30-71234567-8" */
export function cuit(v: Numerico): string {
  if (v === null || v === undefined || v === "") return "—";
  const s = String(v).replace(/\D/g, "");
  if (s.length !== 11) return s;
  return `${s.slice(0, 2)}-${s.slice(2, 10)}-${s.slice(10)}`;
}

/** Acepta "30-71234567-8", "30712345678" o con espacios; devuelve los 11 dígitos o null. */
export function parsearCuit(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.replace(/[\s.-]/g, "");
  return /^\d{11}$/.test(s) ? s : null;
}

/** Dígito verificador de CUIT/CUIL (módulo 11). */
export function cuitValido(v: string): boolean {
  const s = parsearCuit(v);
  if (!s) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((acc, p, i) => acc + p * Number(s[i]), 0);
  let dv = 11 - (suma % 11);
  if (dv === 11) dv = 0;
  if (dv === 10) dv = 9;
  return dv === Number(s[10]);
}

/** Primera letra en mayúscula, el resto como viene. */
export function capital(s: string | null | undefined): string {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Los textos del Boletín vienen a veces en mayúsculas sostenidas. Para títulos
 * se pasan a tipo oración si más del 60 % de las letras son mayúsculas.
 */
export function suavizarMayusculas(s: string | null | undefined): string {
  if (!s) return "";
  const letras = s.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g, "");
  if (letras.length < 6) return s;
  const may = letras.replace(/[^A-ZÁÉÍÓÚÜÑ]/g, "").length;
  if (may / letras.length < 0.6) return s;
  const bajo = s.toLowerCase();
  return bajo.charAt(0).toUpperCase() + bajo.slice(1);
}

/** Recorta en la última palabra completa antes de `max` caracteres. */
export function recortar(s: string | null | undefined, max = 160): string {
  if (!s) return "";
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const corte = t.lastIndexOf(" ", max);
  return t.slice(0, corte > max * 0.6 ? corte : max).replace(/[,;:.\s]+$/, "") + "…";
}

/** "1 proceso" / "2 procesos" */
export function plural(n: number, uno: string, varios: string): string {
  return `${entero(n)} ${n === 1 ? uno : varios}`;
}
