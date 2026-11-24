import { describe, expect, it } from "vitest";
import { cuit, cuitValido, entero, fecha, fechaConDia, fechaCorta, millones, monto, numero, parsearCuit, porcentaje, recortar, suavizarMayusculas } from "@/lib/formato";

describe("números es-AR", () => {
  it("separa miles con punto y decimales con coma", () => {
    expect(numero(1234567.891, 2)).toBe("1.234.567,89");
    expect(entero(19011)).toBe("19.011");
    expect(entero("8772")).toBe("8.772");
    expect(numero(-1500, 0)).toBe("−1.500");
  });
  it("maneja vacíos sin inventar ceros", () => {
    expect(entero(null)).toBe("—");
    expect(porcentaje(undefined)).toBe("—");
    expect(monto(null)).toBe("Sin monto");
  });
  it("porcentajes", () => {
    expect(porcentaje(23.44)).toBe("23,4 %");
    expect(porcentaje("75", 0)).toBe("75 %");
  });
});

describe("montos", () => {
  it("millones con un decimal debajo de 1.000 M", () => {
    expect(monto(221_700_000)).toBe("$ 221,7 M");
    expect(monto("1234500000")).toBe("$ 1.235 M");
    expect(monto(412_380_000_000)).toBe("$ 412.380 M");
  });
  it("montos chicos completos", () => {
    expect(monto(994499)).toBe("$ 994.499");
    expect(monto(12.5)).toBe("$ 12,50");
  });
  it("dólares", () => {
    expect(monto(412000, "USD")).toBe("USD 412.000");
    expect(monto(30_300_000, "USD")).toBe("USD 30,3 M");
  });
  it("millones para gráficos", () => {
    expect(millones(12_345_678_901)).toBe("12.346");
    expect(millones(1_900_000)).toBe("1,9");
    expect(millones(0)).toBe("0");
  });
});

describe("fechas", () => {
  it("dd/mm/aaaa desde ISO", () => {
    expect(fecha("2024-03-14")).toBe("14/03/2024");
    expect(fecha("2024-03-14T10:00:00-03")).toBe("14/03/2024");
    expect(fecha(null)).toBe("Sin fecha");
    expect(fechaCorta("2024-03-14")).toBe("14/03/24");
  });
  it("día de la semana", () => {
    expect(fechaConDia("2024-03-14")).toBe("jueves 14/03/2024");
    expect(fechaConDia("2024-08-30")).toBe("viernes 30/08/2024");
  });
});

describe("CUIT", () => {
  it("formatea y parsea", () => {
    expect(cuit("30703951437")).toBe("30-70395143-7");
    expect(parsearCuit("30-70395143-7")).toBe("30703951437");
    expect(parsearCuit("30.70395143.7")).toBe("30703951437");
    expect(parsearCuit("123")).toBeNull();
  });
  it("valida el dígito verificador", () => {
    expect(cuitValido("30-70395143-7")).toBe(true);
    expect(cuitValido("30-71252366-9")).toBe(true);
    expect(cuitValido("30-70395143-8")).toBe(false);
  });
});

describe("textos", () => {
  it("suaviza mayúsculas sostenidas", () => {
    expect(suavizarMayusculas("SERVICIO DE LIMPIEZA INTEGRAL")).toBe("Servicio de limpieza integral");
    expect(suavizarMayusculas("Servicio de Limpieza")).toBe("Servicio de Limpieza");
  });
  it("recorta en palabra completa", () => {
    expect(recortar("uno dos tres cuatro cinco", 12)).toBe("uno dos tres…");
    expect(recortar("corto", 12)).toBe("corto");
  });
});
