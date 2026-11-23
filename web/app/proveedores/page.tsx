import type { Metadata } from "next";
import Link from "next/link";
import Marco from "@/components/Marco";
import { Paginacion } from "@/components/ui";
import { listarProveedores, POR_PAGINA_LISTA } from "@/lib/datos";
import type { Params } from "@/lib/busqueda";
import { cuit, entero, fecha, monto, porcentaje } from "@/lib/formato";
import { rutaProveedor } from "@/lib/sitio";

export const metadata: Metadata = {
  title: "Proveedores",
  description: "Empresas que ganaron contrataciones de la Ciudad de Buenos Aires según el Boletín Oficial, con su CUIT, monto adjudicado y organismos.",
  alternates: { canonical: "/proveedores" },
};

const uno = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function Proveedores({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const q = uno(sp.q).trim().slice(0, 120);
  const orden = ["monto", "procesos", "nombre"].includes(uno(sp.orden)) ? uno(sp.orden) : "monto";
  const pagina = Math.max(1, Number.parseInt(uno(sp.pagina), 10) || 1);
  const { filas, total, pendientes } = await listarProveedores(q, orden, pagina);
  const qs = (cambios: Record<string, string | number>) => {
    const u = new URLSearchParams();
    if (q) u.set("q", q);
    if (orden !== "monto") u.set("orden", orden);
    for (const [k, v] of Object.entries(cambios)) {
      if ((k === "orden" && v === "monto") || (k === "pagina" && v === 1)) u.delete(k);
      else u.set(k, String(v));
    }
    const s = u.toString();
    return s ? `/proveedores?${s}` : "/proveedores";
  };

  return (
    <Marco activo="proveedores">
      <section className="cabecera">
        <div className="texto">
          <span className="kicker">Proveedores</span>
          <h1 className="titulo">A quién le compra la Ciudad</h1>
          <p className="bajada">
            Empresas y personas con CUIT identificado que ganaron al menos una preadjudicación o adjudicación publicada en el Boletín Oficial. Cada legajo lleva a los procesos y a sus documentos.
          </p>
        </div>
        <div className="aviso-cel" style={{ flex: "1 1 300px" }}>
          <span>
            <strong>{entero(pendientes.n)} firmas ganadoras todavía no tienen CUIT identificado</strong> ({entero(pendientes.actos)} actos
            {pendientes.monto ? `, ≈ ${monto(pendientes.monto, "ARS")}` : ""}). No figuran en esta lista hasta revisarlas. Podés sugerir el CUIT desde la ficha de cada proceso.
          </span>
        </div>
      </section>

      <section className="col g16">
        <form role="search" action="/proveedores" className="busq-grande">
          <label htmlFor="qp" className="sr">
            Buscar proveedores
          </label>
          <input id="qp" name="q" type="search" defaultValue={q} placeholder="Razón social o CUIT" />
          {orden !== "monto" ? <input type="hidden" name="orden" value={orden} /> : null}
          <button className="btn" type="submit">
            Buscar
          </button>
        </form>

        <div className="res-cab">
          <span className="serif num" style={{ fontSize: 24, fontWeight: 600 }}>
            {entero(total)} {total === 1 ? "proveedor" : "proveedores"}
            {q ? <span className="note" style={{ fontFamily: "var(--f-sans)", fontSize: 14, fontWeight: 400 }}> para “{q}”</span> : null}
          </span>
          <div className="fila">
            <span className="note">Ordenar</span>
            <div className="seg" role="group" aria-label="Ordenar por">
              {[
                ["monto", "Monto"],
                ["procesos", "Procesos"],
                ["nombre", "Nombre"],
              ].map(([id, l]) => (
                <Link key={id} href={qs({ orden: id!, pagina: 1 })} className={orden === id ? "on" : ""} aria-current={orden === id ? "true" : undefined}>
                  {l}
                </Link>
              ))}
            </div>
          </div>
        </div>

        {filas.length === 0 ? (
          <div className="box estado">
            <span className="kicker">Sin resultados</span>
            <h2 className="h3">No encontramos proveedores para “{q}”</h2>
            <ul className="p14" style={{ paddingLeft: 18, lineHeight: 1.6 }}>
              <li>Probá con una parte del nombre, sin la forma societaria (S.A., S.R.L.)</li>
              <li>Buscá el CUIT con o sin guiones</li>
              <li>
                Si la firma ganó pero no tiene CUIT identificado, buscala en <Link href={`/procesos?q=${encodeURIComponent(q)}`}>el buscador de procesos</Link>
              </li>
            </ul>
          </div>
        ) : (
          <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Proveedor</th>
                  <th className="r">Adjudicado (ARS)</th>
                  <th className="r">Procesos</th>
                  <th className="r">Organismos</th>
                  <th className="r">Oferta única</th>
                  <th className="r">Por excepción</th>
                  <th>Última</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((p) => (
                  <tr key={p.cuit}>
                    <td style={{ minWidth: 240 }}>
                      <Link href={rutaProveedor(p.cuit)} className="enlace-fila">
                        {p.razon_social ?? `CUIT ${cuit(p.cuit)}`}
                      </Link>
                      <div className="note mono" style={{ fontSize: 12 }}>
                        {cuit(p.cuit)}
                        {p.tipo_societario ? ` · ${p.tipo_societario.toLowerCase()}` : ""}
                      </div>
                    </td>
                    <td className="r num fw6 nowrap">{p.monto_nominal_ars ? monto(p.monto_nominal_ars, "ARS") : <span className="note">—</span>}</td>
                    <td className="r num">{entero(p.procesos_ganados)}</td>
                    <td className="r num">{entero(p.organismos)}</td>
                    <td className="r num">{p.pct_oferta_unica === null ? <span className="note">sin dato</span> : porcentaje(p.pct_oferta_unica)}</td>
                    <td className="r num">{porcentaje(p.pct_excepcion)}</td>
                    <td className="mono num nowrap" style={{ fontSize: 13 }}>
                      {fecha(p.ultima)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Paginacion pagina={pagina} total={total} porPagina={POR_PAGINA_LISTA} href={(n) => qs({ pagina: n })} />
        <p className="note m0">
          Monto: suma de lo asignado a cada firma en pesos corrientes, solo cuando el texto permite atribuirlo (una sola ganadora o monto por firma). Oferta única: sobre los procesos ganados donde el texto informa la cantidad de ofertas.
        </p>
      </section>
    </Marco>
  );
}
