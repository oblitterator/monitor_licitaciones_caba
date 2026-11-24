import type { Metadata } from "next";
import Link from "next/link";
import Marco from "@/components/Marco";
import { listarOrganismos } from "@/lib/datos";
import type { Params } from "@/lib/busqueda";
import { entero, fecha, monto } from "@/lib/formato";
import { rutaOrganismo } from "@/lib/sitio";

export const metadata: Metadata = {
  title: "Organismos",
  description: "Las unidades de compra de la Ciudad de Buenos Aires que publican contrataciones en el Boletín Oficial: procesos, montos adjudicados y concentración.",
  alternates: { canonical: "/organismos" },
};

const uno = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function Organismos({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const q = uno(sp.q).trim().slice(0, 120);
  const orden = ["monto", "procesos", "nombre"].includes(uno(sp.orden)) ? uno(sp.orden) : "monto";
  const filas = await listarOrganismos(q, orden);
  const total = filas.reduce((a, f) => a + Number(f.monto ?? 0), 0);
  const href = (o: string) => {
    const u = new URLSearchParams();
    if (q) u.set("q", q);
    if (o !== "monto") u.set("orden", o);
    const s = u.toString();
    return s ? `/organismos?${s}` : "/organismos";
  };
  return (
    <Marco activo="organismos">
      <section className="cabecera">
        <div className="texto">
          <span className="kicker">Organismos</span>
          <h1 className="titulo">Quién compra en la Ciudad</h1>
          <p className="bajada">
            Cada unidad operativa de adquisiciones (UOA) publica sus llamados y adjudicaciones con su propio número. Un hospital o una dirección general puede ser su propia unidad de compras; el Boletín no informa a qué ministerio pertenece cada una, así que las listamos por separado.
          </p>
        </div>
      </section>

      <section className="col g16">
        <form role="search" action="/organismos" className="busq-grande">
          <label htmlFor="qo" className="sr">
            Buscar organismos
          </label>
          <input id="qo" name="q" type="search" defaultValue={q} placeholder="Nombre o número de UOA (ej. hospital, 401)" />
          {orden !== "monto" ? <input type="hidden" name="orden" value={orden} /> : null}
          <button className="btn" type="submit">
            Buscar
          </button>
        </form>
        <div className="res-cab">
          <span className="serif num" style={{ fontSize: 24, fontWeight: 600 }}>
            {entero(filas.length)} {filas.length === 1 ? "organismo" : "organismos"}
          </span>
          <div className="fila">
            <span className="note">Ordenar</span>
            <div className="seg" role="group" aria-label="Ordenar por">
              {[
                ["monto", "Monto"],
                ["procesos", "Procesos"],
                ["nombre", "Nombre"],
              ].map(([id, l]) => (
                <Link key={id} href={href(id!)} className={orden === id ? "on" : ""} aria-current={orden === id ? "true" : undefined}>
                  {l}
                </Link>
              ))}
            </div>
          </div>
        </div>
        {filas.length === 0 ? (
          <div className="box estado">
            <span className="kicker">Sin resultados</span>
            <h2 className="h3">No encontramos organismos para “{q}”</h2>
            <p className="p14">Probá con una palabra del nombre (por ejemplo “hospital” o “educación”) o con el número de la unidad de compras.</p>
          </div>
        ) : (
          <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Organismo</th>
                  <th>UOA</th>
                  <th className="r">Procesos</th>
                  <th className="r">Adjudicado (ARS)</th>
                  <th style={{ width: "22%" }}>Participación</th>
                  <th>Última publicación</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((o) => {
                  const pct = total ? (100 * Number(o.monto ?? 0)) / total : 0;
                  const sinNombre = !o.nombre || /no se encontr/i.test(o.nombre);
                  return (
                    <tr key={o.id}>
                      <td style={{ minWidth: 240 }}>
                        <Link href={rutaOrganismo(o.id)} className="enlace-fila">
                          {sinNombre ? `Unidad ${o.id} (sin descripción en el Boletín)` : o.nombre}
                        </Link>
                        {o.nombres > 1 ? (
                          <div className="note" style={{ fontSize: 12 }}>
                            publicó con {entero(o.nombres)} nombres distintos
                          </div>
                        ) : null}
                      </td>
                      <td className="mono" style={{ fontSize: 13 }}>
                        {/^\d+$/.test(o.id) ? o.id : "—"}
                      </td>
                      <td className="r num">{entero(o.procesos)}</td>
                      <td className="r num fw6 nowrap">{o.monto ? monto(o.monto, "ARS") : <span className="note">—</span>}</td>
                      <td>
                        <div className="fila" style={{ flexWrap: "nowrap" }}>
                          <div className="bar" style={{ flex: 1 }}>
                            <span style={{ width: `${pct}%` }} />
                          </div>
                          <span className="mono num" style={{ fontSize: 12, width: 48, textAlign: "right" }}>
                            {pct.toFixed(1).replace(".", ",")} %
                          </span>
                        </div>
                      </td>
                      <td className="mono num nowrap" style={{ fontSize: 13 }}>
                        {fecha(o.ultima)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="note m0">Adjudicado: monto de la última adjudicación de cada proceso, en pesos corrientes. Excluye montos improbables (posibles errores de lectura).</p>
      </section>
    </Marco>
  );
}
