// Estado de cada año y mes según los actos cargados (para rayar lo que falta).

export type EstadoAnio = "completo" | "parcial" | "sin";

export function mesesConDatos(meses: { mes: string; actos: number }[]): Set<string> {
  return new Set(meses.filter((m) => m.actos > 0).map((m) => m.mes));
}

/** Años entre el primero y el último con datos, con su estado. */
export function estadoAnios(meses: { mes: string; actos: number }[]): { anio: number; estado: EstadoAnio; meses: number }[] {
  const con = mesesConDatos(meses);
  if (con.size === 0) return [];
  const anios = [...con].map((m) => Number(m.slice(0, 4)));
  const ini = Math.min(...anios);
  const fin = Math.max(...anios);
  const out: { anio: number; estado: EstadoAnio; meses: number }[] = [];
  for (let a = ini; a <= fin; a++) {
    let n = 0;
    for (let m = 1; m <= 12; m++) if (con.has(`${a}-${String(m).padStart(2, "0")}`)) n++;
    out.push({ anio: a, meses: n, estado: n === 0 ? "sin" : n === 12 ? "completo" : "parcial" });
  }
  return out;
}

/** Lista continua de meses (aaaa-mm) desde el primero con datos hasta `hasta` (aaaa-mm). */
export function serieMeses(meses: { mes: string; actos: number }[], hasta?: string): { mes: string; con: boolean }[] {
  const con = mesesConDatos(meses);
  const orden = [...con].sort();
  const primero = orden[0];
  const ultimo = hasta && orden.length && hasta > orden[orden.length - 1]! ? hasta : orden[orden.length - 1];
  if (!primero || !ultimo) return [];
  const out: { mes: string; con: boolean }[] = [];
  let [a, m] = [Number(primero.slice(0, 4)), Number(primero.slice(5, 7))];
  for (let i = 0; i < 600; i++) {
    const k = `${a}-${String(m).padStart(2, "0")}`;
    out.push({ mes: k, con: con.has(k) });
    if (k === ultimo) break;
    m++;
    if (m > 12) {
      m = 1;
      a++;
    }
  }
  return out;
}

/** Texto corto de los huecos: "2021 completo, 01/2019–11/2019" */
export function describirHuecos(serie: { mes: string; con: boolean }[]): string[] {
  const huecos: string[] = [];
  let ini: string | null = null;
  let prev: string | null = null;
  for (const s of [...serie, { mes: "fin", con: true }]) {
    if (!s.con && ini === null) ini = s.mes;
    if (s.con && ini !== null && prev) {
      const f = (x: string) => `${x.slice(5, 7)}/${x.slice(0, 4)}`;
      huecos.push(ini === prev ? f(ini) : `${f(ini)} a ${f(prev)}`);
      ini = null;
    }
    prev = s.mes;
  }
  return huecos;
}
