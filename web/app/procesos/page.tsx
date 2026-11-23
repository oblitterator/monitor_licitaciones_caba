import type { Metadata } from "next";
import Link from "next/link";
import Marco from "@/components/Marco";
import { Conf, Fuente, Monto, Paginacion, Senal } from "@/components/ui";
import { buscarActos, obtenerCobertura, obtenerOrganismosOpciones, type FilaBusqueda } from "@/lib/datos";
import { aQuery, hayFiltros, parsearFiltros, POR_PAGINA, type Filtros, type Params } from "@/lib/busqueda";
import { etapa, GRUPOS_ETAPA, GRUPOS_PROC, procedimiento } from "@/lib/catalogo";
import { entero, fecha, monto, recortar, suavizarMayusculas } from "@/lib/formato";
import { rutaProceso } from "@/lib/sitio";

export const metadata: Metadata = {
  title: "Buscador de procesos",
  description: "Buscá cualquier contratación de la Ciudad publicada en el Boletín Oficial por objeto, código de proceso, expediente, empresa o CUIT.",
  alternates: { canonical: "/procesos" },
};

function ObjetoCelda({ r }: { r: FilaBusqueda }) {
  const obj = recortar(suavizarMayusculas(r.objeto), 150) || r.nombre_norma || "Objeto no identificado";
  return r.codigo_proceso ? (
    <Link href={rutaProceso(r.codigo_proceso)} className="enlace-fila" style={{ display: "block" }}>
      {obj}
    </Link>
  ) : (
    <span className="fw6">{obj}</span>
  );
}

function MontoCelda({ r }: { r: FilaBusqueda }) {
  if (!r.monto_total) return <span className="note">Sin monto</span>;
  return (
    <Monto
      valor={r.monto_total}
      moneda={r.moneda}
      estimado={r.monto_origen === "suma_firmas"}
      dudoso={r.monto_dudoso}
      ia={r.monto_fuente === "llm" ? {} : null}
    />
  );
}

function notaMonto(r: FilaBusqueda): string {
  if (!r.monto_total) return r.etapa === "llamado" ? "no publicado en el llamado" : "no identificado";
  if (r.monto_dudoso) return `${r.moneda ?? "ARS"} · improbable, no se suma`;
  if (r.monto_fuente === "llm") return `${r.moneda ?? "ARS"} · completado con IA`;
  return `${r.moneda ?? "ARS"} · ${r.monto_origen === "suma_firmas" ? "estimado" : "exacto"}`;
}

function Senales({ r }: { r: FilaBusqueda }) {
  if (!r.senales.length) return <span className="note" style={{ fontSize: 12 }}>—</span>;
  return (
    <div className="col g6" style={{ alignItems: "flex-start" }}>
      {r.senales.map((s) => (
        <Senal key={s} tipo={s} na={s === "fraccionamiento"}>
          {s === "fraccionamiento" ? "Fraccionamiento · sin tope" : undefined}
        </Senal>
      ))}
    </div>
  );
}

function Chk({ name, value, checked, children }: { name: string; value: string; checked: boolean; children: React.ReactNode }) {
  return (
    <label className="chk">
      <input type="checkbox" name={name} value={value} defaultChecked={checked} />
      {children}
    </label>
  );
}

function FormFiltros({ f, organismos }: { f: Filtros; organismos: { id: string; nombre: string }[] }) {
  const todas = (arr: string[], v: string) => arr.length === 0 || arr.includes(v);
  return (
    <form action="/procesos" className="filtros" aria-label="Filtros">
      {f.q ? <input type="hidden" name="q" value={f.q} /> : null}
      {f.cuit ? <input type="hidden" name="cuit" value={f.cuit} /> : null}
      {f.orden !== "fecha" ? <input type="hidden" name="orden" value={f.orden} /> : null}
      <div className="entre" style={{ alignItems: "center" }}>
        <span className="h3">Filtros</span>
        <Link href={f.q ? `/procesos?q=${encodeURIComponent(f.q)}` : "/procesos"} style={{ fontSize: 13, padding: "12px 0" }}>
          Limpiar
        </Link>
      </div>
      <div className="par">
        <label className="field">
          Desde
          <input type="date" name="desde" defaultValue={f.desde ?? ""} />
        </label>
        <label className="field">
          Hasta
          <input type="date" name="hasta" defaultValue={f.hasta ?? ""} />
        </label>
      </div>
      <label className="field">
        Organismo
        <select name="org" defaultValue={f.org ?? ""}>
          <option value="">Todos</option>
          {organismos.map((o) => (
            <option key={o.id} value={o.id}>
              {recortar(o.nombre, 60)}
              {/^\d+$/.test(o.id) ? ` (UOA ${o.id})` : ""}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend className="field">Etapa</legend>
        {GRUPOS_ETAPA.map((g) => (
          <Chk key={g.id} name="etapa" value={g.id} checked={todas(f.etapas, g.id)}>
            {g.label}
          </Chk>
        ))}
      </fieldset>
      <fieldset>
        <legend className="field">Tipo de procedimiento</legend>
        {GRUPOS_PROC.map((g) => (
          <Chk key={g.id} name="proc" value={g.id} checked={todas(f.procs, g.id)}>
            {g.label}
          </Chk>
        ))}
        <Chk name="proc" value="otros" checked={todas(f.procs, "otros")}>
          Otros o sin identificar
        </Chk>
      </fieldset>
      <div className="par">
        <label className="field">
          Moneda
          <select name="moneda" defaultValue={f.moneda ?? ""}>
            <option value="">ARS y USD</option>
            <option value="ARS">ARS</option>
            <option value="USD">USD</option>
          </select>
        </label>
        <label className="field">
          Monto mínimo
          <input type="text" inputMode="numeric" name="min" placeholder="$ 0" defaultValue={f.montoMin ?? ""} />
        </label>
      </div>
      <label className="chk fw6">
        <input type="checkbox" name="senales" value="1" defaultChecked={f.conSenal} />
        Solo con señales
      </label>
      <fieldset>
        <legend className="field">Confianza de la extracción</legend>
        {(["alta", "media", "baja"] as const).map((c) => (
          <label key={c} className="chk">
            <input type="checkbox" name="conf" value={c} defaultChecked={todas(f.conf, c)} />
            <Conf nivel={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</Conf>
          </label>
        ))}
      </fieldset>
      <button type="submit" className="btn">
        Aplicar filtros
      </button>
    </form>
  );
}

export default async function Buscador({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const f = parsearFiltros(sp);
  const [{ filas, resumen }, organismos, cob] = await Promise.all([buscarActos(f), obtenerOrganismosOpciones(), obtenerCobertura()]);
  const base = { ...f, pagina: 1 };
  const filtrosActivos = hayFiltros(f);
  const nFiltros = [f.desde || f.hasta, f.org, f.cuit, f.etapas.length, f.procs.length, f.moneda, f.montoMin !== null, f.conSenal, f.senal, f.conf.length].filter(Boolean).length;
  const orgNombre = f.org ? organismos.find((o) => o.id === f.org)?.nombre : null;
  const fueraDeCobertura = (f.desde && f.desde > cob.ultima) || (f.hasta && f.hasta < cob.primera);
  const csv = `/procesos/exportar${aQuery(base) ? "?" + aQuery(base) : ""}`;

  return (
    <Marco activo="procesos">
      <section className="col g14">
        <span className="kicker">Buscador de procesos</span>
        <h1 className="titulo l">Buscá cualquier contratación publicada</h1>
        <form role="search" action="/procesos" className="busq-grande">
          <label htmlFor="q" className="sr">
            Buscar procesos
          </label>
          <input id="q" name="q" type="search" defaultValue={f.q} placeholder="Objeto, código, expediente, empresa o CUIT" />
          {f.org ? <input type="hidden" name="org" value={f.org} /> : null}
          <button type="submit" className="btn">
            Buscar
          </button>
        </form>
        <p className="note m0">
          Buscá por objeto, código de proceso (ej. <span className="mono">401-0258-LPU24</span>), expediente, empresa o CUIT.
        </p>
      </section>

      <div className="fila" style={{ gap: 32, alignItems: "flex-start" }}>
        <FormFiltros f={f} organismos={organismos} />
        <details className="filtros-movil" style={{ width: "100%" }}>
          <summary className="fila">
            <span className="btn sec chico">Filtros{nFiltros ? ` · ${nFiltros}` : ""}</span>
            {orgNombre ? <span className="tag cel">{recortar(orgNombre, 28)}</span> : null}
            {f.desde || f.hasta ? (
              <span className="tag cel">
                {f.desde ? fecha(f.desde) : "…"}–{f.hasta ? fecha(f.hasta) : "…"}
              </span>
            ) : null}
          </summary>
          <FormFiltros f={f} organismos={organismos} />
        </details>

        <section className="resultados" aria-labelledby="res-h" aria-live="polite">
          <div className="res-cab">
            <div className="col g4">
              <span id="res-h" className="serif num" style={{ fontSize: 24, fontWeight: 600 }}>
                {entero(resumen.procesos)} {resumen.procesos === 1 ? "proceso" : "procesos"}
              </span>
              <span className="note">
                {entero(resumen.actos)} {resumen.actos === 1 ? "publicación" : "publicaciones"}
                {resumen.adjudicaciones ? (
                  <>
                    {" "}
                    · las adjudicaciones suman <strong className="num" style={{ color: "var(--ink)" }}>{monto(resumen.ars ?? 0, "ARS")}</strong> +{" "}
                    <strong className="num" style={{ color: "var(--ink)" }}>{monto(resumen.usd ?? 0, "USD")}</strong>
                    {resumen.adj_sin_monto ? ` · ${entero(resumen.adj_sin_monto)} sin monto identificado` : ""}
                  </>
                ) : null}
              </span>
            </div>
            <div className="fila">
              <span className="note">Ordenar</span>
              <div className="seg" role="group" aria-label="Ordenar por">
                <Link href={`/procesos?${aQuery(base, { orden: "fecha" })}`} className={f.orden === "fecha" ? "on" : ""} aria-current={f.orden === "fecha" ? "true" : undefined}>
                  Fecha
                </Link>
                <Link href={`/procesos?${aQuery(base, { orden: "monto" })}`} className={f.orden === "monto" ? "on" : ""} aria-current={f.orden === "monto" ? "true" : undefined}>
                  Monto
                </Link>
              </div>
              {resumen.actos > 0 ? (
                <a className="btn sec chico" href={csv} download>
                  Exportar CSV
                </a>
              ) : null}
              <Link className="btn sec chico" href={`/alertas${f.q ? `?tipo=palabra&valor=${encodeURIComponent(f.q)}` : ""}`}>
                Crear alerta
              </Link>
            </div>
          </div>

          {resumen.actos === 0 ? (
            <div className="box estado">
              <span className="kicker">Sin resultados</span>
              <h2 className="h3">{f.q ? `No encontramos procesos para “${f.q}”` : "No hay publicaciones con estos filtros"}</h2>
              {fueraDeCobertura ? (
                <p className="p14">
                  Las fechas elegidas están fuera de lo cargado: la base cubre del {fecha(cob.primera)} al {fecha(cob.ultima)}. Esto no significa que no hubo contrataciones, sino que esos boletines todavía no están procesados.
                </p>
              ) : null}
              <p className="p14">Podés:</p>
              <ul className="p14" style={{ paddingLeft: 18, lineHeight: 1.6 }}>
                {f.conf.length ? (
                  <li>
                    Quitar el filtro <strong>Confianza</strong> (oculta los actos de otros niveles)
                  </li>
                ) : null}
                {f.desde || f.hasta ? <li>Ampliar el rango de fechas</li> : null}
                <li>Probar con menos palabras o sin acentos</li>
                <li>Buscar por CUIT, código de proceso o número de expediente</li>
              </ul>
              {filtrosActivos ? (
                <Link className="btn sec" href={f.q ? `/procesos?q=${encodeURIComponent(f.q)}` : "/procesos"} style={{ alignSelf: "flex-start" }}>
                  Limpiar filtros
                </Link>
              ) : null}
            </div>
          ) : (
            <>
              <div className="tblwrap tabla-res">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Proceso</th>
                      <th>Procedimiento · etapa</th>
                      <th className="r">Monto</th>
                      <th>Señales</th>
                      <th>Confianza</th>
                      <th>Fuente</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filas.map((r) => (
                      <tr key={r.id_norma}>
                        <td className="mono num nowrap" style={{ fontSize: 13 }}>
                          {fecha(r.fecha_publicacion)}
                        </td>
                        <td style={{ minWidth: 200 }}>
                          <ObjetoCelda r={r} />
                          <div className="codigo" style={{ marginTop: 4 }}>
                            {r.codigo_proceso ?? "Sin código"}
                          </div>
                          <div className="note" style={{ fontSize: 12 }}>
                            {r.organismo}
                          </div>
                        </td>
                        <td style={{ fontSize: 13 }}>
                          <div>{procedimiento(r.tipo_proc)}</div>
                          <span className="tag" style={{ marginTop: 6 }}>
                            {etapa(r.etapa)}
                          </span>
                        </td>
                        <td className="r num fw6">
                          <span className="nowrap"><MontoCelda r={r} /></span>
                          <div className="note nota-monto" style={{ fontSize: 11, fontWeight: 400 }}>
                            {notaMonto(r)}
                          </div>
                        </td>
                        <td>
                          <Senales r={r} />
                        </td>
                        <td>
                          <Conf nivel={r.confianza}>{r.confianza.charAt(0).toUpperCase() + r.confianza.slice(1)}</Conf>
                        </td>
                        <td>
                          <Fuente url={r.url_norma} fecha={r.fecha_publicacion} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="tarjetas-res">
                {filas.map((r) => {
                  const cuerpo = (
                    <>
                      <span className="entre" style={{ alignItems: "center" }}>
                        <span className="tag">{etapa(r.etapa)}</span>
                        <span className="mono num" style={{ fontSize: 12, color: "var(--muted)" }}>
                          {fecha(r.fecha_publicacion)}
                        </span>
                      </span>
                      <span style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.35 }}>{recortar(suavizarMayusculas(r.objeto), 120) || "Objeto no identificado"}</span>
                      <span className="codigo" style={{ fontSize: 11 }}>
                        {r.codigo_proceso ?? "Sin código"} · {procedimiento(r.tipo_proc)}
                      </span>
                      <span className="tarjeta-pie">
                        <span className="num fw7">
                          <MontoCelda r={r} />
                        </span>
                        <Conf nivel={r.confianza} />
                      </span>
                      {r.senales.length ? (
                        <span className="fila">
                          {r.senales.map((s) => (
                            <Senal key={s} tipo={s} na={s === "fraccionamiento"} />
                          ))}
                        </span>
                      ) : null}
                    </>
                  );
                  return r.codigo_proceso ? (
                    <Link key={r.id_norma} href={rutaProceso(r.codigo_proceso)} className="tarjeta-res">
                      {cuerpo}
                    </Link>
                  ) : (
                    <div key={r.id_norma} className="tarjeta-res">
                      {cuerpo}
                    </div>
                  );
                })}
              </div>
              <Paginacion pagina={f.pagina} total={resumen.actos} porPagina={POR_PAGINA} href={(p) => `/procesos?${aQuery(f, { pagina: p })}`} />
              <p className="note m0">
                Una fila por publicación en el Boletín. El monto subrayado con puntos es estimado (suma de los montos por firma). La confianza es la de la extracción automática de ese documento:
                <Link href="/metodologia#confianza">qué significa</Link>.
              </p>
            </>
          )}
        </section>
      </div>
    </Marco>
  );
}
