// Frases de cada caso de señal, armadas solo con datos de la base.

import { procedimiento, senalMeta } from "./catalogo";
import { cuit as fmtCuit, entero, fecha, monto, recortar, suavizarMayusculas } from "./formato";

export type CasoTexto = {
  tipo: string;
  codigo_proceso: string;
  fecha: string | null;
  monto: string | null;
  moneda: string | null;
  detalle: Record<string, unknown>;
  objeto: string | null;
  razon_social: string | null;
  monto_dudoso?: boolean;
};

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

function sujeto(c: CasoTexto): string {
  const o = recortar(suavizarMayusculas(c.objeto), 90);
  return o || `Proceso ${c.codigo_proceso}`;
}

export function textoCaso(c: CasoTexto, hayUmbrales = false): { titulo: string; por: string; leg: string; na: boolean } {
  const leg = senalMeta(c.tipo)?.leg ?? "";
  const m = c.monto && !c.monto_dudoso ? monto(c.monto, c.moneda) : null;
  const d = c.detalle ?? {};
  switch (c.tipo) {
    case "oferta-unica": {
      const n = num(d.n_ofertas);
      return {
        titulo: `${sujeto(c)}: una sola oferta${m ? ` en ${m}` : ""}`,
        por: n === 1 ? "El acta informa una única oferta presentada." : "El texto del acto indica que hubo una sola oferta.",
        leg,
        na: false,
      };
    }
    case "modificaciones": {
      const partes: string[] = [];
      const p = num(d.prorrogas) ?? 0;
      const a = num(d.ampliaciones) ?? 0;
      const mo = num(d.modificaciones) ?? 0;
      if (p) partes.push(p === 1 ? "1 prórroga" : `${p} prórrogas`);
      if (a) partes.push(a === 1 ? "1 ampliación" : `${a} ampliaciones`);
      if (mo) partes.push(mo === 1 ? "1 modificación" : `${mo} modificaciones`);
      const dias = num(d.dias);
      return {
        titulo: `${sujeto(c)}: ${partes.join(", ")}`,
        por:
          dias !== null && dias >= 0
            ? `La primera se publicó ${entero(dias)} días después de la adjudicación${m ? ` (adjudicado: ${m})` : ""}.`
            : `Publicada el ${fecha(c.fecha)}${m ? `; monto adjudicado ${m}` : ""}.`,
        leg,
        na: false,
      };
    }
    case "empresa-nueva": {
      const dias = num(d.dias) ?? 0;
      const meses = Math.max(1, Math.round(dias / 30.4));
      const nombre = (d.razon_social as string) || c.razon_social || "Una empresa";
      return {
        titulo: `${nombre} ganó a los ${meses === 1 ? "1 mes" : `${meses} meses`} de constituida`,
        por: `Constitución en el padrón: ${fecha(d.constitucion as string)}. Adjudicación publicada: ${fecha(c.fecha)}.`,
        leg,
        na: false,
      };
    }
    case "domicilio-compartido":
      return {
        titulo: `${d.firma_1 ?? fmtCuit(d.cuit_1 as string)} y ${d.firma_2 ?? fmtCuit(d.cuit_2 as string)} comparten domicilio fiscal`,
        por: `Aparecen en el mismo acto del ${fecha(c.fecha)}. Domicilio del padrón: ${d.domicilio ?? "—"}.`,
        leg,
        na: false,
      };
    case "fraccionamiento": {
      const n = num(d.n_90d) ?? 3;
      const suma = d.suma_90d ? monto(d.suma_90d as string, "ARS") : null;
      const tope = d.tope ? monto(d.tope as string, "ARS") : null;
      return {
        titulo: `${entero(n)} contrataciones menores o directas en 90 días al mismo proveedor`,
        por: `${suma ? `Suman ${suma}. ` : ""}${hayUmbrales && tope ? `Tope del procedimiento: ${tope}${d.supera_tope ? "; la suma lo supera." : "; la suma no lo supera."}` : "Tope del procedimiento: no cargado, no se puede comparar."}`,
        leg,
        na: !(hayUmbrales && tope),
      };
    }
    case "excepcion":
      return {
        titulo: sujeto(c),
        por: `${procedimiento(d.tipo_proc as string)}${m ? ` por ${m}` : ""}.`,
        leg,
        na: false,
      };
    default:
      return { titulo: sujeto(c), por: "", leg, na: false };
  }
}
