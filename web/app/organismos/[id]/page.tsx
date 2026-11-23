import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Marco from "@/components/Marco";
import { BarrasAnio, Kpi, LeyendaBarras, Monto, Ruta, Senal, type Barra } from "@/components/ui";
import { obtenerCobertura, obtenerOrganismo } from "@/lib/datos";
import { estadoAnios } from "@/lib/cobertura";
import { HHI_ALTO, HHI_MODERADO, nombreOrganismo } from "@/lib/catalogo";
import { cuit, entero, fecha, monto, porcentaje, recortar, suavizarMayusculas } from "@/lib/formato";
import { NOMBRE_SITIO, rutaOrganismo, rutaProceso, rutaProveedor } from "@/lib/sitio";
import { textoCaso } from "@/lib/textos-senal";

type P = { params: Promise<{ id: string }>; searchParams: Promise<{ anio?: string }> };

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const id = decodeURIComponent((await params).id);
  const d = await obtenerOrganismo(id, null);
  if (!d) return { title: "Organismo no encontrado", robots: { index: false } };
  const nombre = nombreOrganismo(d.nombres[0]?.organismo, id);
  const desc = `${nombre}: ${entero(d.resumen?.procesos ?? 0)} procesos de compra publicados en el Boletín Oficial de la Ciudad${d.resumen?.monto ? `, ${monto(d.resumen.monto, "ARS")} adjudicados` : ""}. Proveedores principales, concentración y procedimientos de excepción.`;
  return {
    title: nombre,
    description: desc,
    alternates: { canonical: rutaOrganismo(id) },
    openGraph: { title: `${nombre} · legajo de organismo`, description: desc, url: rutaOrganismo(id), siteName: NOMBRE_SITIO },
  };
}

export default async function Organismo({ params, searchParams }: P) {
  const id = decodeURIComponent((await params).id);
  const anioQ = Number.parseInt((await searchParams).anio ?? "", 10);
  const [d, cob] = await Promise.all([obtenerOrganismo(id, Number.isFinite(anioQ) ? anioQ : null), obtenerCobertura()]);
  if (!d) notFound();
  const nombre = nombreOrganismo(d.nombres[0]?.organismo, id);
  const otros = d.nombres.slice(1).filter((n) => n.organismo && !/no se encontr/i.test(n.organismo));
  const porAnio = new Map(d.anios.map((a) => [a.anio, a]));
  const estados = estadoAnios(cob.meses);
  const barras: Barra[] = estados.map((e) => ({
    anio: e.anio,
    estado: e.estado,
    valor: porAnio.get(e.anio)?.monto ? Number(porAnio.get(e.anio)!.monto) : e.estado === "sin" ? null : 0,
  }));
  const estadoAnio = estados.find((e) => e.anio === d.anio);
  const anioTxt = d.anio ? `${d.anio}${estadoAnio?.estado === "parcial" ? " (parcial)" : ""}` : "—";
  const hhi = d.hhi?.hhi ? Number(d.hhi.hhi) : null;
  const equivalentes = hhi ? Math.max(1, Math.round(10000 / hhi)) : null;
  const pr = d.procedimiento;
  const pctMenor = pr?.procesos ? (100 * pr.menores) / pr.procesos : 0;
  const pctDirecta = pr?.procesos ? (100 * pr.directas) / pr.procesos : 0;
  const pctResto = 100 - pctMenor - pctDirecta;
  const sumaTop = d.proveedores.reduce((a, p) => a + Number(p.pct ?? 0), 0);
  const totalAnio = Number(d.totalAnio?.total ?? 0);
  const pctSinCuit = totalAnio ? (100 * Number(d.totalAnio?.sin_cuit ?? 0)) / totalAnio : 0;
  const hayUmbrales = cob.umbrales > 0;

  return (
    <Marco activo="organismos">
      <Ruta items={[{ href: "/organismos", label: "Organismos" }, { label: nombre }]} />

      <header className="cabecera">
        <div className="texto" style={{ flexBasis: 560 }}>
          <span className="kicker">Legajo de organismo{/^\d+$/.test(id) ? ` · UOA ${id}` : ""}</span>
          <h1 className="titulo">{nombre}</h1>
          <p className="m0" style={{ fontSize: 16, lineHeight: 1.5, color: "var(--ink2)" }}>
            Unidad de compras que publica en el Boletín con el número {id}. Publicó entre el {fecha(d.nombres.reduce((a, n) => (n.desde < a ? n.desde : a), d.nombres[0]!.desde))} y el{" "}
            {fecha(d.nombres.reduce((a, n) => (n.hasta > a ? n.hasta : a), d.nombres[0]!.hasta))}.
            {otros.length ? ` También aparece como: ${otros.slice(0, 3).map((o) => o.organismo).join("; ")}.` : ""}
          </p>
        </div>
        <div className="fila" style={{ alignItems: "flex-end" }}>
          {d.anios.length > 1 ? (
            <form className="fila" action={rutaOrganismo(id)} style={{ alignItems: "flex-end" }}>
              <label className="field">
                Año
                <select name="anio" defaultValue={String(d.anio ?? "")} style={{ width: "auto" }}>
                  {d.anios
                    .slice()
                    .reverse()
                    .map((a) => (
                      <option key={a.anio} value={a.anio}>
                        {a.anio}
                        {estados.find((e) => e.anio === a.anio)?.estado === "parcial" ? " (parcial)" : ""}
                      </option>
                    ))}
                </select>
              </label>
              <button className="btn sec" type="submit">
                Ver
              </button>
            </form>
          ) : null}
          <a className="btn" href={`/procesos/exportar?org=${encodeURIComponent(id)}`} download>
            Exportar CSV
          </a>
        </div>
      </header>

      <section aria-label="Resumen" className="kpis chicos">
        <Kpi l="Procesos" v={entero(d.resumen?.procesos ?? 0)} n="con algún acto publicado, toda la base" />
        <Kpi l="Adjudicado" v={d.resumen?.monto ? monto(d.resumen.monto, "ARS") : "—"} n="pesos corrientes, toda la base" />
        <Kpi
          l="Con oferta única"
          v={d.resumen?.con_dato ? porcentaje((100 * d.resumen.unica) / d.resumen.con_dato) : "—"}
          n={d.resumen?.con_dato ? `${entero(d.resumen.unica)} de ${entero(d.resumen.con_dato)} con dato de ofertas` : "el texto no informa ofertas"}
          vacio={!d.resumen?.con_dato}
        />
        <Kpi l={`Por excepción · ${anioTxt}`} v={pr?.pct_excepcion_cantidad ? porcentaje(pr.pct_excepcion_cantidad) : "—"} n="contratación menor y directa" vacio={!pr} />
      </section>

      <div className="dos">
        <section className="ancha col g16">
          <h2 className="h2">Gasto adjudicado por año</h2>
          {d.anios.length === 0 ? (
            <p className="note m0">Este organismo no tiene adjudicaciones con fecha en la base.</p>
          ) : (
            <>
              <BarrasAnio barras={barras} etiqueta={`Gasto adjudicado por ${nombre} por año, en millones de pesos corrientes`} alto={190} />
              <LeyendaBarras />
              <p className="note m0">Millones de pesos corrientes. Los años rayados tienen datos parciales o no están cargados.</p>
            </>
          )}
        </section>

        <section className="lateral box col g14" style={{ flexBasis: 380, padding: 24 }}>
          <span className="kicker">Concentración de proveedores · {anioTxt}</span>
          {hhi === null ? (
            <>
              <span className="senal na" style={{ alignSelf: "flex-start" }}>
                Sin datos suficientes
              </span>
              <p className="p14">No hay adjudicaciones en pesos asignables a firmas con CUIT en {d.anio ?? "este período"}: no se puede calcular el índice.</p>
            </>
          ) : (
            <>
              <div className="fila" style={{ alignItems: "baseline", gap: 10 }}>
                <span className="serif num" style={{ fontSize: 52, lineHeight: 1, fontWeight: 700 }}>
                  {entero(hhi)}
                </span>
                <span className="note">índice HHI, de 0 a 10.000</span>
              </div>
              <div className="col g6">
                <div className="hhi-escala" aria-hidden="true">
                  <span style={{ flex: 15, background: "var(--celwash)" }} />
                  <span style={{ flex: 10, background: "var(--cel2)" }} />
                  <span style={{ flex: 75, background: "var(--cel)" }} />
                  <span className="marca-hhi" style={{ left: `calc(${Math.min(100, hhi / 100)}% - 1px)` }} />
                </div>
                <div className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)" }}>
                  <span>0</span>
                  <span>1.500</span>
                  <span>2.500</span>
                  <span>10.000</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--ink2)" }}>
                  <span>Poco</span>
                  <span>Moderado</span>
                  <span>Alto</span>
                </div>
              </div>
              {hhi >= HHI_ALTO ? <Senal tipo="concentracion" href="/senales/concentracion" /> : null}
              <p className="p15" style={{ color: "var(--ink)" }}>
                <strong>En criollo:</strong> el gasto está repartido como si hubiera {equivalentes === 1 ? <strong>un solo proveedor</strong> : <>unos <strong>{entero(equivalentes)} proveedores de igual tamaño</strong></>}. Cuanto más alto el número, menos empresas concentran el dinero
                {hhi >= HHI_ALTO ? " (alto)" : hhi >= HHI_MODERADO ? " (moderado)" : " (bajo)"}.
              </p>
              <p className="note m0">
                Sobre {entero(d.hhi?.proveedores ?? 0)} proveedores con CUIT y {monto(d.hhi?.monto_total, "ARS")} asignables. Se calcula sumando el cuadrado de la participación (%) de cada proveedor. <Link href="/senales/concentracion">Metodología</Link>
              </p>
            </>
          )}
        </section>
      </div>

      <div className="dos">
        <section className="ancha col g14">
          <h2 className="h2">Principales proveedores · {anioTxt}</h2>
          {d.proveedores.length === 0 ? (
            <p className="note m0">Sin adjudicaciones con monto asignable a firmas con CUIT en el año.</p>
          ) : (
            <div className="tblwrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Proveedor</th>
                    <th className="r">Adjudicado</th>
                    <th style={{ width: "34%" }}>Participación</th>
                  </tr>
                </thead>
                <tbody>
                  {d.proveedores.map((p) => (
                    <tr key={p.cuit}>
                      <td>
                        <Link href={rutaProveedor(p.cuit)} className="enlace-fila">
                          {p.nombre ?? cuit(p.cuit)}
                        </Link>
                        <div className="mono note" style={{ fontSize: 12 }}>
                          {cuit(p.cuit)} · {entero(p.n)} {p.n === 1 ? "proceso" : "procesos"}
                        </div>
                      </td>
                      <td className="r num fw6 nowrap">{monto(p.monto, "ARS")}</td>
                      <td>
                        <div className="fila" style={{ flexWrap: "nowrap" }}>
                          <div className="bar" style={{ flex: 1 }}>
                            <span style={{ width: `${Number(p.pct ?? 0)}%` }} />
                          </div>
                          <span className="mono num" style={{ fontSize: 12, width: 48, textAlign: "right" }}>
                            {porcentaje(p.pct)}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {d.proveedores.length ? (
            <p className="note m0">
              Resto: {entero(Math.max(0, (d.totalAnio?.proveedores ?? 0) - d.proveedores.length))} proveedores, {porcentaje(Math.max(0, 100 - sumaTop - pctSinCuit))}. Sin CUIT identificado: {porcentaje(pctSinCuit)}.
            </p>
          ) : null}
        </section>

        <section className="lateral col g14">
          <h2 className="h2">Procedimientos de excepción</h2>
          {!pr ? (
            <p className="note m0">Sin procesos adjudicados en {d.anio ?? "el período"}.</p>
          ) : (
            <>
              <div className="fila" style={{ alignItems: "baseline", gap: 10 }}>
                <span className="serif num" style={{ fontSize: 44, fontWeight: 700, lineHeight: 1 }}>
                  {porcentaje(pr.pct_excepcion_cantidad, 0)}
                </span>
                <span className="note">de los procesos de {anioTxt}</span>
              </div>
              <div className="apilada" aria-hidden="true">
                <span style={{ flex: pctResto, background: "var(--rule)" }} />
                <span style={{ flex: pctMenor, background: "var(--celdeep)" }} />
                <span style={{ flex: pctDirecta, background: "var(--ink)" }} />
              </div>
              <div className="col g6" style={{ fontSize: 14 }}>
                <span className="fila">
                  <span className="cuadro" style={{ width: 12, height: 12, background: "var(--rule)" }} />
                  Licitación u otro procedimiento · {porcentaje(pctResto, 0)}
                </span>
                <span className="fila">
                  <span className="cuadro" style={{ width: 12, height: 12, background: "var(--celdeep)" }} />
                  Contratación menor · {porcentaje(pctMenor, 0)} ({entero(pr.menores)})
                </span>
                <span className="fila">
                  <span className="cuadro" style={{ width: 12, height: 12, background: "var(--ink)" }} />
                  Contratación directa · {porcentaje(pctDirecta, 0)} ({entero(pr.directas)})
                </span>
              </div>
              <p className="note m0">
                Promedio de la Ciudad en {d.anio}: {porcentaje(d.ciudad)}. Las urgencias y los insumos de proveedor único suelen elevarlo.
                {pr.pct_excepcion_monto_nominal ? ` En monto: ${porcentaje(pr.pct_excepcion_monto_nominal)}.` : ""}
              </p>
            </>
          )}
        </section>
      </div>

      <section className="grilla-2">
        <div className="col g14">
          <h2 className="h2">Posible fraccionamiento</h2>
          <div className="col g10" style={{ padding: 16, border: "1px dashed var(--rule)", borderRadius: 4 }}>
            <Senal tipo="fraccionamiento" na={!hayUmbrales}>
              {hayUmbrales ? undefined : "No calculable todavía"}
            </Senal>
            <p className="p14">
              {hayUmbrales ? "" : "Los topes legales por procedimiento no están cargados. "}
              {d.fracc.casos ? (
                <>
                  Encontramos <strong>{entero(d.fracc.casos)} contrataciones</strong> menores o directas que forman grupos de 3 o más al mismo proveedor en 90 días ({entero(d.fracc.proveedores)}{" "}
                  {d.fracc.proveedores === 1 ? "proveedor" : "proveedores"}){hayUmbrales ? "." : "; sin el tope no podemos decir si superan el límite."}
                </>
              ) : (
                "No hay grupos de 3 o más contrataciones menores o directas al mismo proveedor en 90 días."
              )}
            </p>
            {d.fracc.casos ? (
              <Link href={`/senales/fraccionamiento?org=${encodeURIComponent(id)}`} style={{ fontSize: 14 }}>
                Ver los casos →
              </Link>
            ) : null}
          </div>
        </div>
        <div className="col g14">
          <h2 className="h2">Modificaciones posteriores</h2>
          {d.modif.length === 0 ? (
            <p className="note m0">Sin prórrogas, ampliaciones ni modificaciones publicadas.</p>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Proceso</th>
                  <th>Tipo</th>
                  <th className="r">Adjudicado</th>
                </tr>
              </thead>
              <tbody>
                {d.modif.map((m) => {
                  const t = textoCaso(m);
                  return (
                    <tr key={m.codigo_proceso}>
                      <td>
                        <Link href={rutaProceso(m.codigo_proceso)} className="enlace-fila">
                          {recortar(suavizarMayusculas(m.objeto), 70) || m.codigo_proceso}
                        </Link>
                        <div className="codigo">{m.codigo_proceso}</div>
                      </td>
                      <td style={{ fontSize: 13 }}>{t.titulo.split(": ").slice(-1)[0]}</td>
                      <td className="r num fw6 nowrap">{m.monto ? <Monto valor={m.monto} moneda={m.moneda} dudoso={m.monto_dudoso} /> : <span className="note">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </Marco>
  );
}
