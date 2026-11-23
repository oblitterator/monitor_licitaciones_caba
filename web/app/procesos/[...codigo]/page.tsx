import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Marco from "@/components/Marco";
import { ReporteForm } from "@/components/ReporteForm";
import { Conf, Fuente, IaEtiqueta, Monto, Ruta, Senal } from "@/components/ui";
import { obtenerProceso, type Acto, type Firma } from "@/lib/datos";
import { etapa, faltante, procedimiento, senalMeta } from "@/lib/catalogo";
import { capital, cuit, entero, fecha, monto, recortar, suavizarMayusculas } from "@/lib/formato";
import { NOMBRE_SITIO, rutaOrganismo, rutaProceso, rutaProveedor } from "@/lib/sitio";
import { textoCaso } from "@/lib/textos-senal";
import { turnstileSiteKey } from "@/lib/turnstile";

type P = { params: Promise<{ codigo: string[] }> };

async function leer(params: P["params"]) {
  const { codigo } = await params;
  const c = codigo.map((s) => decodeURIComponent(s)).join("/");
  if (c.length > 60) return { c, datos: null };
  return { c, datos: await obtenerProceso(c) };
}

function titulo(objeto: string | null | undefined, codigo: string) {
  return recortar(suavizarMayusculas(objeto), 180) || `Proceso ${codigo}`;
}

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const { c, datos } = await leer(params);
  if (!datos) return { title: "Proceso no encontrado", robots: { index: false } };
  const p = datos.proceso;
  const obj = titulo(p?.objeto ?? datos.actos.find((a) => a.objeto)?.objeto, c);
  const m = p?.monto_adjudicado ? `Adjudicado por ${monto(p.monto_adjudicado, p.moneda_adjudicado)}. ` : "";
  const desc = `${c} · ${p?.organismo ?? datos.actos[0]?.organismo ?? ""}. ${m}${entero(datos.actos.length)} publicaciones en el Boletín Oficial, cada una con su PDF.`;
  return {
    title: `${recortar(obj, 70)} (${c})`,
    description: desc,
    alternates: { canonical: rutaProceso(c) },
    openGraph: { title: `${recortar(obj, 90)} · ${c}`, description: desc, url: rutaProceso(c), type: "article", siteName: NOMBRE_SITIO },
  };
}

function estadoProceso(actos: Acto[]): { label: string; ink: boolean } {
  const e = new Set(actos.map((a) => a.etapa));
  if (actos.some((a) => a.fracasada) || e.has("fracasada")) return { label: "Fracasada", ink: false };
  if (e.has("deja_sin_efecto")) return { label: "Dejada sin efecto", ink: false };
  if (e.has("adjudicacion")) return { label: "Adjudicada", ink: true };
  if (e.has("preadjudicacion")) return { label: "Preadjudicada", ink: true };
  if (e.has("llamado")) return { label: "En llamado", ink: false };
  return { label: "En trámite", ink: false };
}

const ORDEN_ROL: Record<string, number> = { adjudicada: 0, preadjudicada: 1, oferente: 2, desestimada: 3, mencionada: 4 };
const ROL: Record<string, string> = { adjudicada: "Adjudicada", preadjudicada: "Preadjudicada", oferente: "Oferente", desestimada: "Desestimada", mencionada: "Mencionada" };

function citaLlm(a: Acto, campo: string): string | null {
  const ev = a.evidencias ?? {};
  const v = (ev as Record<string, unknown>)[campo];
  return typeof v === "string" ? v : null;
}

function descActo(a: Acto, firmas: Firma[]): string {
  const ganadoras = firmas.filter((f) => f.id_norma === a.id_norma && (f.rol === "adjudicada" || f.rol === "preadjudicada"));
  const oferentes = firmas.filter((f) => f.id_norma === a.id_norma && (f.rol === "oferente" || f.rol === "desestimada"));
  const m = a.monto_total ? monto(a.monto_total, a.moneda) : null;
  const nombres = (fs: Firma[]) => {
    const n = fs.map((f) => f.razon_social ?? f.nombre_raw);
    return n.length > 2 ? `${n.slice(0, 2).join(", ")} y ${n.length - 2} más` : n.join(" y ");
  };
  switch (a.etapa) {
    case "llamado":
      return `Publicación del llamado.${m ? ` Monto informado: ${m}.` : " Presupuesto oficial no informado en el texto."}`;
    case "apertura":
      return a.n_ofertas ? `${entero(a.n_ofertas)} ${a.n_ofertas === 1 ? "oferta" : "ofertas"}.` : "Acta de apertura. La cantidad de ofertas no figura en el texto.";
    case "preadjudicacion":
    case "adjudicacion": {
      const quien = ganadoras.length ? nombres(ganadoras) : "Firma no identificada en el texto";
      const extra = oferentes.length ? ` ${entero(oferentes.length)} oferentes más listados.` : "";
      return `${quien}${m ? ` por ${m}` : ""}.${extra}`;
    }
    case "prorroga":
    case "ampliacion":
    case "modificacion":
      return m ? `${etapa(a.etapa)} por ${m}.` : `${etapa(a.etapa)} publicada. Sin monto identificado.`;
    default:
      return a.nombre_norma ? recortar(a.nombre_norma, 120) : etapa(a.etapa);
  }
}

export default async function FichaProceso({ params }: P) {
  const { c, datos } = await leer(params);
  if (!datos) notFound();
  const { proceso: p, actos, firmas, ganadores, senales, hayUmbrales } = datos;
  const siteKey = turnstileSiteKey();
  const ruta = rutaProceso(c);
  const nro = new Map(actos.map((a, i) => [a.id_norma, i + 1]));
  const fn = (ids: (string | undefined)[]) => {
    const ns = [...new Set(ids.filter(Boolean).map((i) => nro.get(i!)).filter(Boolean))] as number[];
    return ns.length ? (
      <a className="fn" href="#fuentes" aria-label={`Fuente: documento ${ns.join(", ")}`}>
        [{ns.join(",")}]
      </a>
    ) : null;
  };

  const objeto = p?.objeto ?? actos.find((a) => a.objeto)?.objeto ?? null;
  const organismo = p?.organismo ?? actos[0]?.organismo ?? null;
  const organismoId = p?.organismo_id ?? actos[0]?.organismo_id ?? null;
  const tipoProc = p?.tipo_proc ?? actos.find((a) => a.tipo_proc)?.tipo_proc ?? null;
  const expediente = actos.find((a) => a.expediente)?.expediente ?? null;
  const est = estadoProceso(actos);
  const conModif = (p?.n_ampliaciones ?? 0) > 0 ? "Con ampliación" : (p?.n_prorrogas ?? 0) > 0 ? "Con prórroga" : (p?.n_modificaciones ?? 0) > 0 ? "Con modificaciones" : null;

  // acto final: el de la última adjudicación (o preadjudicación) con monto
  const final =
    [...actos].reverse().find((a) => a.etapa === "adjudicacion" && a.monto_total) ??
    [...actos].reverse().find((a) => a.etapa === "preadjudicacion" && a.monto_total) ??
    [...actos].reverse().find((a) => a.etapa === "adjudicacion" || a.etapa === "preadjudicacion") ??
    actos.at(-1);
  const etiquetaMonto = final?.etapa === "adjudicacion" ? "Monto adjudicado" : final?.etapa === "preadjudicacion" ? "Monto preadjudicado" : "Monto informado";
  const dudoso = (a?: Acto) => Boolean(a?.monto_total && Number(a.monto_total) > (a.moneda === "USD" ? 1e9 : 1e12));
  const peor = actos.reduce<"alta" | "media" | "baja">((acc, a) => (a.confianza === "baja" || (a.confianza === "media" && acc === "alta") ? a.confianza : acc), "alta");
  const faltan = [...new Set((final?.faltantes ?? []).map(faltante))];
  const conIa = actos.some((a) => a.usa_llm && (a.etapa_fuente === "llm" || a.codigo_fuente === "llm" || a.monto_fuente === "llm")) || firmas.some((f) => f.fuente === "llm");
  const ampliaciones = actos.filter((a) => (a.etapa === "ampliacion" || a.etapa === "prorroga") && a.monto_total);

  // oferentes: todas las firmas del proceso, una fila por firma (CUIT o nombre)
  const porFirma = new Map<string, Firma & { actos: string[] }>();
  for (const f of firmas) {
    const k = f.cuit ?? `n:${f.nombre_norm ?? f.nombre_raw}`;
    const prev = porFirma.get(k);
    if (!prev) porFirma.set(k, { ...f, actos: [f.id_norma] });
    else {
      prev.actos.push(f.id_norma);
      if ((ORDEN_ROL[f.rol] ?? 9) < (ORDEN_ROL[prev.rol] ?? 9)) Object.assign(prev, { rol: f.rol, monto: f.monto ?? prev.monto });
      if (!prev.monto && f.monto) prev.monto = f.monto;
    }
  }
  const oferentes = [...porFirma.values()].sort((a, b) => (ORDEN_ROL[a.rol] ?? 9) - (ORDEN_ROL[b.rol] ?? 9));
  const nDesestimadas = oferentes.filter((o) => o.rol === "desestimada").length;
  const camposReporte = ["Objeto", "Organismo", "Procedimiento", "Monto", "Ganadores", "Oferentes", "Fechas", "Otro"];

  const tl = actos.map((a) => ({
    a,
    sinPdf: !a.url_norma,
  }));

  return (
    <Marco activo="procesos" ficha>
      <Ruta items={[{ href: "/procesos", label: "Procesos" }, { label: <span className="mono">{c}</span> }]} />

      <header className="ficha-cab">
        <div className="texto">
          <div className="fila">
            <span className="mono fw6" style={{ fontSize: 15, color: "var(--celdeep)" }}>
              {c}
            </span>
            {actos.some((a) => a.codigo_fuente === "llm") ? <IaEtiqueta cita={citaLlm(actos.find((a) => a.codigo_fuente === "llm")!, "codigo_proceso")} modelo={actos.find((a) => a.codigo_fuente === "llm")?.llm_modelo} /> : null}
            <span className={est.ink ? "tag ink" : "tag"}>{est.label}</span>
            {conModif ? <span className="tag cel">{conModif}</span> : null}
          </div>
          <h1 className="titulo l">{titulo(objeto, c)}</h1>
          <dl className="dl">
            <div>
              <dt className="kicker">Organismo</dt>
              <dd>
                {organismoId ? (
                  <Link href={rutaOrganismo(organismoId)} className="fw6">
                    {organismo}
                  </Link>
                ) : (
                  organismo
                )}
              </dd>
            </div>
            <div>
              <dt className="kicker">Procedimiento</dt>
              <dd>{procedimiento(tipoProc)}</dd>
            </div>
            <div>
              <dt className="kicker">Expediente</dt>
              <dd className="mono" style={{ fontSize: 13, overflowWrap: "anywhere" }}>
                {expediente ?? "No figura en las publicaciones"}
              </dd>
            </div>
            <div>
              <dt className="kicker">{etiquetaMonto}</dt>
              <dd className="num fw7">
                {final?.monto_total ? (
                  <>
                    <Monto
                      valor={final.monto_total}
                      moneda={final.moneda}
                      estimado={final.monto_origen === "suma_firmas"}
                      dudoso={dudoso(final)}
                      ia={final.monto_fuente === "llm" ? { cita: citaLlm(final, "monto_total"), modelo: final.llm_modelo } : null}
                    />{" "}
                    <span className="tag">{final.moneda ?? "ARS"}</span>
                    {fn([final.id_norma])}
                  </>
                ) : (
                  <span className="note">Sin monto identificado</span>
                )}
              </dd>
            </div>
          </dl>
          {ampliaciones.length ? (
            <p className="note m0">
              Además: {ampliaciones.map((a, i) => (
                <span key={a.id_norma}>
                  {i ? "; " : ""}
                  {etapa(a.etapa).toLowerCase()} por {monto(a.monto_total, a.moneda)}
                  {fn([a.id_norma])}
                </span>
              ))}
              . No se suman al monto: el texto no siempre aclara si es un monto adicional o el nuevo total.
            </p>
          ) : null}
        </div>
        <aside className="box calidad" aria-label="Calidad del dato">
          <span className="kicker">Calidad del dato</span>
          <span style={{ fontSize: 15 }}>
            <Conf nivel={final?.confianza ?? peor} largo />
          </span>
          {final?.confianza === "baja" && final.monto_origen === "suma_firmas" ? (
            <div className="aviso-baja">El monto sale de la suma de los montos por firma, no de un total publicado.</div>
          ) : null}
          <div className="p14">
            <strong>Campos que faltan:</strong> {faltan.length ? faltan.join(", ") + "." : "ninguno de los campos clave."}
          </div>
          {peor !== (final?.confianza ?? peor) ? <div className="note">Otras publicaciones del proceso tienen confianza {peor}.</div> : null}
          {conIa ? (
            <div className="note">
              Algunos valores los completó un modelo de lenguaje y están marcados <span className="tag ia">Extraído con IA</span>.
            </div>
          ) : null}
          {dudoso(final) ? <div className="aviso-baja">El monto es improbable para un contrato de la Ciudad (posible error de lectura) y no se suma en los totales.</div> : null}
          <div className="note">
            Extraído automáticamente de {entero(actos.length)} {actos.length === 1 ? "documento" : "documentos"} · versión del parser {final?.parser_version ?? "—"}
          </div>
          <ReporteForm tipo="error" entidad="proceso" clave={c} pagina={ruta} etiqueta="Reportar un error en este dato" campos={camposReporte} siteKey={siteKey} />
        </aside>
      </header>

      <section aria-labelledby="tl-h" className="col g18">
        <h2 id="tl-h" className="h2">
          Línea de tiempo
        </h2>
        <ol className="tl">
          {tl.map(({ a, sinPdf }) => (
            <li key={a.id_norma}>
              <div className="tl-linea">
                <span aria-hidden="true" className={sinPdf ? "tl-punto off" : "tl-punto"} />
                <span aria-hidden="true" className="tl-raya" />
              </div>
              <div className="tl-cuerpo">
                <span className="entre">
                  <span className="kicker" style={{ color: "var(--ink)" }}>
                    {etapa(a.etapa)}
                    {a.etapa_fuente === "llm" ? <IaEtiqueta cita={citaLlm(a, "etapa")} modelo={a.llm_modelo} /> : null}
                  </span>
                  <span className="mono num" style={{ fontSize: 14 }}>
                    {fecha(a.fecha_publicacion)}
                  </span>
                </span>
                <span className="tl-desc">
                  {descActo(a, firmas)}
                  {a.monto_fuente === "llm" ? <IaEtiqueta cita={citaLlm(a, "monto_total")} modelo={a.llm_modelo} /> : null}
                </span>
                <span className="fila">
                  <Fuente url={a.url_norma} fecha={a.fecha_publicacion} etiqueta="PDF" />
                  {a.confianza !== "alta" ? <Conf nivel={a.confianza} /> : null}
                </span>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <div className="dos">
        <div className="ancha col g36">
          <section className="col g14">
            <h2 className="h2">Ganadores</h2>
            {ganadores.length === 0 ? (
              <p className="note m0">
                {actos.some((a) => a.etapa === "adjudicacion" || a.etapa === "preadjudicacion")
                  ? "La adjudicación está publicada pero no pudimos identificar a la firma ganadora en el texto. Revisá el PDF."
                  : "Todavía no hay preadjudicación ni adjudicación publicada para este proceso."}
              </p>
            ) : (
              <div className="tblwrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Firma</th>
                      <th>CUIT</th>
                      <th>Según</th>
                      <th className="r">Monto asignado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ganadores.map((g) => (
                      <tr key={`${g.id_norma}-${g.orden}`}>
                        <td>
                          {g.cuit ? (
                            <Link href={rutaProveedor(g.cuit)} className="enlace-fila">
                              {g.razon_social ?? g.nombre_raw}
                            </Link>
                          ) : (
                            <span className="fw6">“{g.nombre_raw}”</span>
                          )}
                        </td>
                        <td className="mono nowrap" style={{ fontSize: 13 }}>
                          {g.cuit ? (
                            cuit(g.cuit)
                          ) : (
                            <span className="sin-cuit" style={{ fontFamily: "var(--f-sans)" }}>
                              No identificado ·{" "}
                              <ReporteForm tipo="cuit" entidad="firma" clave={g.nombre_raw} pagina={ruta} etiqueta="sugerir" nombreFirma={g.nombre_raw} siteKey={siteKey} comoEnlace />
                            </span>
                          )}
                        </td>
                        <td style={{ fontSize: 13 }}>
                          {etapa(g.etapa)} del {fecha(g.fecha_publicacion)}
                        </td>
                        <td className="r num fw7 nowrap">
                          {g.monto_asignado ? (
                            <>
                              <Monto valor={g.monto_asignado} moneda={g.moneda} dudoso={Number(g.monto_asignado) > 1e12} /> <span className="tag">{g.n_ganadoras === 1 ? "total del acto" : "por firma"}</span>
                            </>
                          ) : g.monto_no_asignable ? (
                            <span className="note" style={{ fontWeight: 400 }}>
                              No asignable: {entero(g.n_ganadoras)} ganadoras sin monto por firma
                            </span>
                          ) : (
                            <span className="note">Sin monto</span>
                          )}
                          {fn([g.id_norma])}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="col g14">
            <div className="entre">
              <h2 className="h2">Firmas mencionadas</h2>
              <span className="note">
                {p?.n_ofertas ? `${entero(p.n_ofertas)} ofertas según el texto` : "Cantidad de ofertas no informada"}
                {nDesestimadas ? ` · ${entero(nDesestimadas)} desestimadas` : ""}
                {fn(actos.filter((a) => a.n_ofertas).map((a) => a.id_norma))}
              </span>
            </div>
            {oferentes.length === 0 ? (
              <p className="note m0">No se identificaron firmas en las publicaciones de este proceso.</p>
            ) : (
              <div className="tblwrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Firma</th>
                      <th>CUIT</th>
                      <th>Rol</th>
                      <th className="r">Monto en el texto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {oferentes.map((o) => (
                      <tr key={o.cuit ?? o.nombre_norm ?? o.nombre_raw}>
                        <td>
                          {o.cuit ? (
                            <Link href={rutaProveedor(o.cuit)} className="enlace-fila">
                              {o.razon_social ?? o.nombre_raw}
                            </Link>
                          ) : (
                            <span className="fw6">“{o.nombre_raw}”</span>
                          )}
                          {o.fuente === "llm" ? <IaEtiqueta cita={o.evidencia} /> : null}
                          {o.cuit && o.razon_social && o.resolucion !== "cuit_en_texto" ? (
                            <div className="note" style={{ fontSize: 12 }}>
                              En el Boletín: “{recortar(o.nombre_raw, 60)}”
                            </div>
                          ) : null}
                        </td>
                        <td className="mono nowrap" style={{ fontSize: 13 }}>
                          {o.cuit ? (
                            cuit(o.cuit)
                          ) : (
                            <span className="sin-cuit" style={{ fontFamily: "var(--f-sans)" }}>
                              No identificado ·{" "}
                              <ReporteForm tipo="cuit" entidad="firma" clave={o.nombre_norm ?? o.nombre_raw} pagina={ruta} etiqueta="sugerir" nombreFirma={o.nombre_raw} siteKey={siteKey} comoEnlace />
                            </span>
                          )}
                        </td>
                        <td>
                          <span className={o.rol === "adjudicada" || o.rol === "preadjudicada" ? "tag ink" : "tag"}>{ROL[o.rol] ?? o.rol}</span>
                        </td>
                        <td className="r num">
                          {o.monto ? <Monto valor={o.monto} moneda={actos.find((a) => a.id_norma === o.id_norma)?.moneda ?? "ARS"} /> : <span className="note">—</span>}
                          {fn(o.actos)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {oferentes.some((o) => !o.cuit) ? (
              <p className="note m0">
                Las firmas sin CUIT identificado aparecen tal como las publica el Boletín y no suman a rankings ni a legajos hasta revisarlas.
              </p>
            ) : null}
          </section>
        </div>

        <aside aria-labelledby="sp-h" className="lateral col g14">
          <h2 id="sp-h" className="h2">
            Señales en este proceso
          </h2>
          <p className="note m0">Sirven para priorizar la revisión. No implican que haya una irregularidad.</p>
          {senales.length === 0 ? (
            <div className="box tarjeta-senal" style={{ borderStyle: "dashed" }}>
              <span className="tag" style={{ alignSelf: "flex-start" }}>
                Sin señales marcadas
              </span>
              <p className="p14">
                Evaluamos oferta única, modificaciones, empresa nueva, domicilio compartido y posible fraccionamiento. Ninguna se marcó con los datos disponibles
                {p?.unica_oferta === null ? " (el texto no informa la cantidad de ofertas)" : ""}.
              </p>
            </div>
          ) : null}
          {senales.map((s) => {
            const t = textoCaso(s, hayUmbrales);
            return (
              <article key={`${s.tipo}-${s.cuit}-${s.fecha}`} className={`box tarjeta-senal${t.na ? " na" : ""}`} style={{ padding: 18 }}>
                <Senal tipo={s.tipo} na={t.na}>
                  {t.na ? `${senalMeta(s.tipo)?.nombre} · no calculable` : undefined}
                </Senal>
                <p className="m0" style={{ fontSize: 14, lineHeight: 1.5 }}>
                  <strong>Por qué se marcó:</strong> {t.titulo.includes(": ") ? capital(t.titulo.split(": ").slice(-1)[0]) : t.titulo}. {t.por}
                </p>
                <p className="note m0">
                  <strong style={{ color: "var(--ink2)" }}>Puede explicarse por:</strong> {t.leg.charAt(0).toLowerCase() + t.leg.slice(1)}
                </p>
                <Link href={`/senales/${s.tipo}`} style={{ fontSize: 13 }}>
                  Metodología de esta señal →
                </Link>
              </article>
            );
          })}
        </aside>
      </div>

      <section id="fuentes" className="fuentes">
        <h2 className="kicker m0">Documentos de este proceso</h2>
        <ol>
          {actos.map((a) => (
            <li key={a.id_norma} id={`doc-${nro.get(a.id_norma)}`}>
              <strong>{etapa(a.etapa)}</strong> · <span className="mono" style={{ fontSize: 13 }}>{a.nombre_norma ?? `Norma ${a.id_norma}`}</span> · BO {fecha(a.fecha_publicacion)} ·{" "}
              <Fuente url={a.url_norma} fecha={a.fecha_publicacion} etiqueta="PDF" />{" "}
              {a.doc_estado !== "ok" ? <span className="note">(texto no procesado: {a.doc_estado ?? "sin documento"})</span> : null}
              {a.doc_sha ? (
                <span className="note mono" style={{ fontSize: 11 }}>
                  {" "}
                  · SHA-256 {a.doc_sha.slice(0, 4)}…{a.doc_sha.slice(-3)}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
        <p className="note m0">
          Los enlaces van al PDF oficial en documentosboletinoficial.buenosaires.gob.ar. Si un enlace dejó de funcionar, avisanos con “Reportar un error”.
        </p>
      </section>
    </Marco>
  );
}
