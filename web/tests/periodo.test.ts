import { describe, expect, it } from "vitest";
import { etiquetaAnio, parsearPeriodo, queryPeriodo } from "@/lib/periodo";
import { describirHuecos, estadoAnios, serieMeses } from "@/lib/cobertura";

const P = "2019-12-10";
const U = "2024-03-14";

describe("período del tablero", () => {
  it("por defecto, el último año con datos", () => {
    expect(parsearPeriodo({}, P, U)).toMatchObject({ tipo: "anio", anio: 2024, desde: "2024-01-01", hasta: "2024-12-31", etiqueta: "enero a marzo de 2024" });
  });
  it("mes con fin de mes correcto", () => {
    expect(parsearPeriodo({ periodo: "mes", mes: "2024-02" }, P, U)).toMatchObject({ desde: "2024-02-01", hasta: "2024-02-29", etiqueta: "febrero de 2024" });
  });
  it("rango invertido se ordena", () => {
    expect(parsearPeriodo({ periodo: "rango", desde: "2023-05-01", hasta: "2023-01-01" }, P, U)).toMatchObject({ desde: "2023-01-01", hasta: "2023-05-01" });
  });
  it("año fuera de la base vuelve al último", () => {
    expect(parsearPeriodo({ anio: "1990" }, P, U).anio).toBe(2024);
  });
  it("etiquetas de años incompletos", () => {
    expect(etiquetaAnio(2019, P, U)).toBe("diciembre de 2019");
    expect(etiquetaAnio(2022, P, U)).toBe("2022");
  });
  it("query string", () => {
    expect(queryPeriodo({ tipo: "anio", anio: 2023 })).toBe("?anio=2023");
    expect(queryPeriodo({ tipo: "mes", desde: "2024-03-14" })).toBe("?periodo=mes&mes=2024-03");
  });
});

describe("cobertura", () => {
  const meses = [
    { mes: "2020-11", actos: 3 },
    { mes: "2020-12", actos: 1 },
    { mes: "2021-02", actos: 0 },
    { mes: "2022-01", actos: 5 },
  ];
  it("estado por año: sin datos se distingue de cero", () => {
    expect(estadoAnios(meses)).toEqual([
      { anio: 2020, estado: "parcial", meses: 2 },
      { anio: 2021, estado: "sin", meses: 0 },
      { anio: 2022, estado: "parcial", meses: 1 },
    ]);
  });
  it("serie continua y huecos", () => {
    const s = serieMeses(meses, "2022-03");
    expect(s[0]).toEqual({ mes: "2020-11", con: true });
    expect(s.at(-1)).toEqual({ mes: "2022-03", con: false });
    expect(describirHuecos(s)).toEqual(["01/2021 a 12/2021", "02/2022 a 03/2022"]);
  });
});
