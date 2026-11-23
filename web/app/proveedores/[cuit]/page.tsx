import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Marco from "@/components/Marco";
import { ReporteForm } from "@/components/ReporteForm";
import { BarrasAnio, Fuente, Kpi, LeyendaBarras, Monto, Ruta, Senal, type Barra } from "@/components/ui";
import { obtenerCobertura, obtenerProveedor } from "@/lib/datos";
import { estadoAnios } from "@/lib/cobertura";
import { etapa } from "@/lib/catalogo";
import { cuit as fmtCuit, entero, fecha, monto, parsearCuit, porcentaje, recortar, suavizarMayusculas } from "@/lib/formato";
import { NOMBRE_SITIO, rutaOrganismo, rutaProceso, rutaProveedor } from "@/lib/sitio";
import { textoCaso } from "@/lib/textos-senal";
import { turnstileSiteKey } from "@/lib/turnstile";

type P = { params: Promise<{ cuit: string }> };

async function leer(params: P["params"]) {
  const { cuit } = await params;
  const c = parsearCuit(decodeURIComponent(cuit));
  return { c, datos: c ? await obtenerProveedor(c) : null };
}

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const { c, datos } = await leer(params);
  if (!c || !datos) return { title: "Proveedor no encontrado", robots: { index: false } };
  const nombre = datos.empresa?.razon_social ?? datos.resumen?.razon_social ?? datos.nombres[0]?.nombre_raw ?? fmtCuit(c);
  const r = datos.resumen;
  const desc = r
    ? `${nombre} (CUIT ${fmtCuit(c)}) ganó ${entero(r.procesos_ganados)} procesos de la Ciudad de Buenos Aires${r.monto_nominal_ars ? ` por ${monto(r.monto_nominal_ars, "ARS")}` : ""}, en ${entero(r.organismos)} organismos.`
    : `${nombre} (CUIT ${fmtCuit(c)}): presentaciones en contrataciones de la Ciudad de Buenos Aires.`;
  return {
    title: `${nombre} · CUIT ${fmtCuit(c)}`,
    description: desc,
    alternates: { canonical: rutaProveedor(c) },
    openGraph: { title: `${nombre} · legajo de proveedor`, description: desc, url: rutaProveedor(c), type: "profile", siteName: NOMBRE_SITIO },
  };
}

export default async function Proveedor({ params }: P) {
  const { c, datos } = await leer(params);
  if (!c || !datos) notFound();
  const cob = await obtenerCobertura();
  const { empresa, resumen, presentaciones, nombres, anios, organismos, historial, senales, concentracion, domicilio, unicas } = datos;
  const nombre = empresa?.razon_social ?? resumen?.razon_social ?? nombres[0]?.nombre_raw ?? `CUIT ${fmtCuit(c)}`;
  const ganadas = resumen?.procesos_ganados ?? 0;
  const ruta = rutaProveedor(c);
  const siteKey = turnstileSiteKey();
  const porAnio = new Map(anios.map((a) => [a.anio, a]));
  const barras: Barra[] = estadoAnios(cob.meses).map((e) => ({
    anio: e.anio,
    estado: e.estado,
    valor: porAnio.get(e.anio)?.monto ? Number(porAnio.get(e.anio)!.monto) : e.estado === "sin" ? null : 0,
  }));
  const hayUmbrales = cob.umbrales > 0;
  const fracc = senales.filter((s) => s.tipo === "fraccionamiento");
  const nueva = senales.find((s) => s.tipo === "empresa-nueva");
  const primeraAdj = resumen?.primera ?? null;
  const edadPrimera =
    empresa?.fecha_contrato_social && primeraAdj ? (Date.parse(primeraAdj) - Date.parse(empresa.fecha_contrato_social)) / (365.25 * 864e5) : null;
  const tasa = presentaciones.ofertas ? (100 * ganadas) / presentaciones.ofertas : null;
  const parciales = barras.filter((b) => b.estado !== "completo").map((b) => `${b.anio}: ${b.estado === "sin" ? "sin datos" : "datos parciales"}`);

  return (
    <Marco activo="proveedores">
      <Ruta items={[{ href: "/proveedores", label: "Proveedores" }, { label: nombre }]} />

      <header className="cabecera">
        <div className="texto" style={{ flexBasis: 560 }}>
          <span className="kicker">Legajo de proveedor</span>
          <h1 className="titulo">{nombre}</h1>
          <dl className="dl" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px 24px" }}>
            <div>
              <dt className="kicker">CUIT</dt>
              <dd className="mono">{fmtCuit(c)}</dd>
            </div>
            <div>
              <dt className="kicker">Constitución</dt>
              <dd className="num">{empresa?.fecha_contrato_social ? fecha(empresa.fecha_contrato_social) : <span className="note">No figura en el padrón</span>}</dd>
            </div>
            <div>
              <dt className="kicker">Domicilio fiscal</dt>
              <dd>{empresa?.dom_fiscal ? suavizarMayusculas(empresa.dom_fiscal) : <span className="note">No figura en el padrón</span>}</dd>
            </div>
            <div>
              <dt className="kicker">Fuente</dt>
              <dd>
                {empresa ? (
                  <span className="src">
                    {empresa.fuente === "rns" ? "Registro Nacional de Sociedades" : empresa.fuente === "bac" ? "Buenos Aires Compras" : "Boletín Oficial"}
                  </span>
                ) : (
                  <span className="src off">Sin registro en el padrón</span>
                )}
              </dd>
            </div>
          </dl>
          {empresa?.tipo_societario ? <p className="note m0">{suavizarMayusculas(empresa.tipo_societario)}</p> : null}
          {!empresa ? (
            <p className="note m0">
              Las personas humanas y algunas sociedades no figuran en el padrón de sociedades: el CUIT sale del texto del Boletín.
            </p>
          ) : null}
        </div>
        <div className="fila">
          <a className="btn sec" href={`/procesos/exportar?cuit=${c}`} download>
            Exportar CSV
          </a>
          <Link className="btn sec" href={`/alertas?tipo=proveedor&valor=${c}`}>
            Seguir · alerta
          </Link>
        </div>
      </header>

      <section aria-label="Resumen" className="kpis chicos">
        <Kpi l="Total adjudicado" v={resumen?.monto_nominal_ars ? monto(resumen.monto_nominal_ars, "ARS") : "—"} n={`pesos corrientes, ${fecha(cob.primera).slice(3)}–${fecha(cob.ultima).slice(3)}`} vacio={!resumen?.monto_nominal_ars} />
        <Kpi
          l="Procesos ganados"
          v={entero(ganadas)}
          n={resumen?.procesos_monto_no_asignable ? `${entero(resumen.procesos_monto_no_asignable)} sin monto asignable a la firma` : "preadjudicados o adjudicados"}
        />
        <Kpi l="Presentaciones" v={entero(presentaciones.ofertas)} n="procesos donde figura como oferente o ganadora" />
        <Kpi l="Tasa de éxito" v={tasa === null ? "—" : porcentaje(Math.min(100, tasa), 0)} n={presentaciones.ofertas ? `${entero(ganadas)} de ${entero(presentaciones.ofertas)}` : "sin presentaciones"} vacio={tasa === null} />
        <Kpi l="Con oferta única" v={entero(unicas)} n={`de sus ${entero(ganadas)} procesos ganados`} />
      </section>

      <div className="dos">
        <section className="ancha col g16">
          <div className="entre">
            <h2 className="h2">Adjudicado por año</h2>
          </div>
          {anios.length === 0 ? (
            <p className="note m0">Esta firma no tiene adjudicaciones con CUIT en la base.</p>
          ) : (
            <>
              <BarrasAnio barras={barras} etiqueta={`Monto adjudicado a ${nombre} por año, en millones de pesos corrientes`} />
              <LeyendaBarras />
              <p className="note m0">
                Millones de pesos corrientes. {parciales.join(". ")}. En pesos corrientes la inflación agranda los años recientes: no compares años entre sí hasta que esté el ajuste por IPC.
              </p>
            </>
          )}
        </section>

        <section className="lateral col g16">
          <h2 className="h2">Dónde gana y dónde se presenta</h2>
          {organismos.length === 0 ? (
            <p className="note m0">Sin presentaciones vinculadas a un proceso.</p>
          ) : (
            <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Organismo</th>
                  <th className="r">Se presentó</th>
                  <th className="r">Ganó</th>
                </tr>
              </thead>
              <tbody>
                {organismos.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={rutaOrganismo(o.id)} className="enlace-fila">
                        {o.nombre}
                      </Link>
                    </td>
                    <td className="r num">{entero(o.presento)}</td>
                    <td className="r num fw7">{entero(o.gano)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
          <p className="note m0">Procesos distintos en los que la firma figura en algún acto, con su CUIT.</p>
        </section>
      </div>

      <section className="col g16">
        <div className="col g6">
          <h2 className="h2">Señales evaluadas para este proveedor</h2>
          <p className="note m0">Mostramos todas las que calculamos, también las que no se marcaron. Una señal no implica una irregularidad.</p>
        </div>
        <div className="tarjetas">
          {concentracion.length ? (
            <article className="box tarjeta-senal" style={{ padding: 18 }}>
              <Senal tipo="concentracion" />
              <p className="p14" style={{ color: "var(--ink)" }}>
                Es el principal proveedor de {concentracion.length === 1 ? "un organismo" : `${entero(concentracion.length)} organismos-año`}:{" "}
                {concentracion
                  .slice(0, 2)
                  .map((k) => `${porcentaje(k.pct_principal, 0)} de lo adjudicado por ${k.organismo} en ${k.anio} (HHI ${entero(k.hhi)})`)
                  .join("; ")}
                .
              </p>
              <p className="note m0">
                <strong style={{ color: "var(--ink2)" }}>Puede explicarse por:</strong> contratos grandes plurianuales, pocos oferentes con escala en el rubro.
              </p>
            </article>
          ) : (
            <article className="box tarjeta-senal na" style={{ padding: 18 }}>
              <span className="tag" style={{ alignSelf: "flex-start" }}>
                No se marcó · concentración
              </span>
              <p className="p14">No es el principal proveedor de ningún organismo en ningún año.</p>
            </article>
          )}
          {domicilio.length ? (
            <article className="box tarjeta-senal" style={{ padding: 18 }}>
              <Senal tipo="domicilio-compartido" />
              <p className="p14" style={{ color: "var(--ink)" }}>
                Comparte domicilio fiscal con {entero(domicilio.length)} {domicilio.length === 1 ? "firma" : "firmas"} que aparecen en los mismos actos.
              </p>
              <p className="note m0">
                <strong style={{ color: "var(--ink2)" }}>Puede explicarse por:</strong> estudios contables o edificios de oficinas que domicilian a muchas empresas.
              </p>
            </article>
          ) : (
            <article className="box tarjeta-senal na" style={{ padding: 18 }}>
              <span className="tag" style={{ alignSelf: "flex-start" }}>
                No se marcó · domicilio compartido
              </span>
              <p className="p14">{empresa?.dom_fiscal ? "Ninguna otra firma del mismo acto tiene su domicilio fiscal." : "Sin domicilio fiscal en el padrón: no se puede evaluar."}</p>
            </article>
          )}
          {fracc.length ? (
            <article className={`box tarjeta-senal${hayUmbrales ? "" : " na"}`} style={{ padding: 18 }}>
              <Senal tipo="fraccionamiento" na={!hayUmbrales}>
                {hayUmbrales ? undefined : "Posible fraccionamiento · no calculable"}
              </Senal>
              <p className="p14" style={{ color: "var(--ink)" }}>
                {hayUmbrales ? "" : "Faltan los topes por procedimiento. "}Hay {entero(fracc.length)} contrataciones menores o directas que forman grupos de 3 o más en 90 días con el mismo organismo
                {hayUmbrales ? "." : ", sin comparar contra el tope."}
              </p>
            </article>
          ) : (
            <article className="box tarjeta-senal na" style={{ padding: 18 }}>
              <span className="tag" style={{ alignSelf: "flex-start" }}>
                No se marcó · posible fraccionamiento
              </span>
              <p className="p14">No tiene 3 o más contrataciones menores o directas con un mismo organismo en 90 días.</p>
            </article>
          )}
          {nueva ? (
            <article className="box tarjeta-senal" style={{ padding: 18 }}>
              <Senal tipo="empresa-nueva" />
              <p className="p14" style={{ color: "var(--ink)" }}>
                {textoCaso(nueva).titulo}. {textoCaso(nueva).por}
              </p>
              <p className="note m0">
                <strong style={{ color: "var(--ink2)" }}>Puede explicarse por:</strong> empresas nuevas formadas por equipos con trayectoria, escisiones o cambios de razón social.
              </p>
            </article>
          ) : (
            <article className="box tarjeta-senal na" style={{ padding: 18 }}>
              <span className="tag" style={{ alignSelf: "flex-start" }}>
                No se marcó · empresa nueva
              </span>
              <p className="p14">
                {edadPrimera !== null
                  ? `Tenía ${entero(Math.floor(edadPrimera))} ${Math.floor(edadPrimera) === 1 ? "año" : "años"} de constituida en su primera adjudicación de la base.`
                  : "Sin fecha de constitución en el padrón: no se puede evaluar."}
              </p>
            </article>
          )}
        </div>
      </section>

      {domicilio.length ? (
        <section className="col g14">
          <h2 className="h2">Empresas con el mismo domicilio fiscal</h2>
          <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Firma</th>
                  <th>CUIT</th>
                  <th>Constitución</th>
                  <th>Actos en común</th>
                </tr>
              </thead>
              <tbody>
                {domicilio.map((d) => (
                  <tr key={d.cuit}>
                    <td>
                      <Link href={rutaProveedor(d.cuit)} className="enlace-fila">
                        {d.razon_social}
                      </Link>
                    </td>
                    <td className="mono" style={{ fontSize: 13 }}>
                      {fmtCuit(d.cuit)}
                    </td>
                    <td className="num">{fecha(d.fecha_contrato_social)}</td>
                    <td>
                      {d.procesos.map((p, i) => (
                        <span key={p}>
                          {i ? ", " : ""}
                          <Link href={rutaProceso(p)} className="mono" style={{ fontSize: 13 }}>
                            {p}
                          </Link>
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="col g14">
        <div className="entre">
          <h2 className="h2">Historial de adjudicaciones</h2>
          {ganadas > 0 ? (
            <Link href={`/procesos?cuit=${c}`} style={{ fontSize: 14 }}>
              Ver todas sus publicaciones →
            </Link>
          ) : null}
        </div>
        {historial.length === 0 ? (
          <p className="note m0">Sin preadjudicaciones ni adjudicaciones a este CUIT en la base.</p>
        ) : (
          <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Proceso</th>
                  <th>Organismo</th>
                  <th>Ofertas</th>
                  <th className="r">Monto</th>
                  <th>Fuente</th>
                </tr>
              </thead>
              <tbody>
                {historial.map((h) => (
                  <tr key={h.codigo_proceso}>
                    <td className="mono num nowrap" style={{ fontSize: 13 }}>
                      {fecha(h.fecha_publicacion)}
                    </td>
                    <td style={{ minWidth: 220 }}>
                      <Link href={rutaProceso(h.codigo_proceso)} className="enlace-fila">
                        {recortar(suavizarMayusculas(h.objeto), 90) || h.codigo_proceso}
                      </Link>
                      <div className="codigo">
                        {h.codigo_proceso} · {etapa(h.etapa)}
                      </div>
                    </td>
                    <td style={{ fontSize: 13 }}>
                      {h.organismo_id ? <Link href={rutaOrganismo(h.organismo_id)}>{h.organismo}</Link> : h.organismo}
                    </td>
                    <td className="num">{h.unica_oferta ? "1 (única)" : h.n_ofertas ? entero(h.n_ofertas) : "—"}</td>
                    <td className="r num fw6 nowrap">
                      {h.monto_asignado ? (
                        <Monto valor={h.monto_asignado} moneda={h.moneda} dudoso={h.monto_dudoso} />
                      ) : h.monto_no_asignable ? (
                        <span className="note" style={{ fontWeight: 400 }}>
                          compartido
                        </span>
                      ) : (
                        <span className="note">—</span>
                      )}
                    </td>
                    <td>
                      <Fuente url={h.url_norma} fecha={h.fecha_publicacion} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nombres.length > 1 ? (
          <p className="note m0">
            En el Boletín aparece como: {nombres.map((n) => `“${n.nombre_raw}” (${entero(n.n)})`).join(", ")}.
          </p>
        ) : null}
      </section>

      <section className="aviso-cel" style={{ flexWrap: "wrap", justifyContent: "space-between", padding: "22px 24px", gap: "16px 32px" }}>
        <div className="col g6" style={{ flex: "1 1 520px" }}>
          <span className="h3">¿Representás a esta empresa?</span>
          <p className="p14">Podés pedir una corrección o enviar una aclaración. Si corresponde, la publicamos junto al dato, con fecha.</p>
        </div>
        <div className="col g8" style={{ flex: "1 1 280px" }}>
          <ReporteForm tipo="error" entidad="proveedor" clave={c} pagina={ruta} etiqueta="Reportar un error o ejercer el derecho a réplica" campos={["Razón social", "CUIT", "Adjudicaciones", "Montos", "Señales", "Otro"]} siteKey={siteKey} />
        </div>
      </section>
    </Marco>
  );
}
