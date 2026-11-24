import Link from "next/link";
import { Fuente, Monto, Paginacion, Senal } from "@/components/ui";
import { aniosConSenales, contarSenales, listarCasos, listarConcentracion, obtenerCobertura, obtenerOrganismosOpciones, POR_PAGINA_LISTA } from "@/lib/datos";
import { nombreOrganismo, SENALES, type SenalMeta } from "@/lib/catalogo";
import { cuit, entero, fecha, monto, porcentaje, recortar, suavizarMayusculas } from "@/lib/formato";
import { rutaOrganismo, rutaProceso, rutaProveedor } from "@/lib/sitio";
import { textoCaso } from "@/lib/textos-senal";

export type FiltrosSenal = { org: string | null; anio: number | null; orden: string; pagina: number };

/** Pantalla de señales: lista de tipos a la izquierda, método y casos a la derecha. */
export default async function VistaSenales({ sel, f }: { sel: SenalMeta; f: FiltrosSenal }) {
  const [conteo, cob, anios, organismos] = await Promise.all([contarSenales(), obtenerCobertura(), aniosConSenales(), obtenerOrganismosOpciones()]);
  const hayUmbrales = cob.umbrales > 0;
  const na = sel.id === "fraccionamiento" && !hayUmbrales;
  const esHhi = sel.id === "concentracion";
  const casos = esHhi ? null : await listarCasos(sel.id, f.org, f.anio, f.orden, f.pagina);
  const hhi = esHhi ? await listarConcentracion(f.anio, f.pagina) : null;
  const total = casos?.total ?? hhi?.total ?? 0;
  const href = (cambios: Partial<FiltrosSenal>) => {
    const x = { ...f, ...cambios };
    const u = new URLSearchParams();
    if (x.org) u.set("org", x.org);
    if (x.anio) u.set("anio", String(x.anio));
    if (x.orden && x.orden !== "fecha") u.set("orden", x.orden);
    if (x.pagina > 1) u.set("pagina", String(x.pagina));
    const s = u.toString();
    return `/senales/${sel.id}${s ? "?" + s : ""}`;
  };

  return (
    <>
      <header className="cabecera">
        <div className="texto">
          <span className="kicker">Señales</span>
          <h1 className="titulo">Dónde conviene mirar primero</h1>
          <p className="bajada" style={{ maxWidth: 700 }}>
            Las señales ordenan la revisión: marcan patrones que vale la pena verificar. <strong>No son acusaciones ni prueban irregularidades.</strong> Cada una tiene su método publicado y sus explicaciones legítimas.
          </p>
        </div>
        <div className="aviso-sol" style={{ flex: "1 1 280px", padding: 16 }}>
          Si una señal te parece mal calculada o tenés contexto que la explica, <Link href="/metodologia#correcciones">contanos</Link>.
        </div>
      </header>

      <div className="fila" style={{ gap: 32, alignItems: "flex-start" }}>
        <nav aria-label="Tipos de señal" className="tipos">
          {SENALES.map((t) => (
            <Link key={t.id} href={`/senales/${t.id}`} className="tipo" aria-current={t.id === sel.id ? "page" : undefined}>
              <span className="col" style={{ gap: 3 }}>
                <span style={{ fontSize: 15, fontWeight: 600 }}>{t.nombre}</span>
                <span className="tipo-sub">{t.corto}</span>
              </span>
              <span className="mono num" style={{ fontSize: 13, fontWeight: 600 }}>
                {t.id === "fraccionamiento" && !hayUmbrales ? "—" : entero(conteo[t.id] ?? 0)}
              </span>
            </Link>
          ))}
        </nav>

        <section className="resultados" style={{ gap: 24 }} aria-labelledby="sel-h">
          <div className="entre" style={{ alignItems: "center" }}>
            <div className="fila" style={{ gap: 12 }}>
              <Senal na={na}>{sel.nombre}</Senal>
              <span id="sel-h" className="serif num" style={{ fontSize: 24, fontWeight: 600 }}>
                {na ? `${entero(total)} candidatos` : `${entero(total)} ${total === 1 ? "caso" : "casos"}`}
              </span>
            </div>
            <form className="fila" action={`/senales/${sel.id}`} style={{ alignItems: "flex-end" }}>
              {!esHhi ? (
                <label className="field">
                  Organismo
                  <select name="org" defaultValue={f.org ?? ""} style={{ maxWidth: 260 }}>
                    <option value="">Todos</option>
                    {organismos.map((o) => (
                      <option key={o.id} value={o.id}>
                        {recortar(nombreOrganismo(o.nombre, o.id), 50)}
                        {/^\d+$/.test(o.id) ? ` (UOA ${o.id})` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="field">
                Año
                <select name="anio" defaultValue={f.anio ? String(f.anio) : ""}>
                  <option value="">Todos</option>
                  {anios.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
              {!esHhi ? (
                <label className="field">
                  Ordenar
                  <select name="orden" defaultValue={f.orden}>
                    <option value="fecha">Más recientes</option>
                    <option value="monto">Monto</option>
                  </select>
                </label>
              ) : null}
              <button type="submit" className="btn sec">
                Filtrar
              </button>
            </form>
          </div>

          <div className="metodo">
            <div>
              <span className="kicker">Qué mide</span>
              <p>{sel.mide}</p>
            </div>
            <div>
              <span className="kicker">Cómo se calcula</span>
              <p>{sel.calc}</p>
            </div>
            <div>
              <span className="kicker">Razones legítimas</span>
              <p>{sel.leg}</p>
            </div>
          </div>

          {na ? (
            <div className="aviso-na">
              <strong>No calculable todavía.</strong> Necesitamos los topes legales por procedimiento y por año (tabla <span className="mono">ref.umbral_procedimiento</span>), que todavía no están cargados. Mostramos los
              candidatos sin compararlos con el tope: cada fila es una contratación que es la tercera o posterior al mismo proveedor y organismo dentro de 90 días.
            </div>
          ) : null}
          {sel.id === "oferta-unica" ? (
            <p className="note m0">Solo se puede evaluar en los procesos donde el Boletín informa la cantidad de ofertas: en el resto no sabemos si hubo competencia.</p>
          ) : null}

          {total === 0 ? (
            <div className="box estado">
              <span className="kicker">Sin casos</span>
              <h2 className="h3">No hay casos {f.org || f.anio ? "con estos filtros" : "calculados para esta señal"}</h2>
              <p className="p14">
                {sel.id === "domicilio-compartido"
                  ? "Hace falta que dos firmas del mismo acto tengan CUIT resuelto y domicilio fiscal en el padrón. Con los datos cargados no encontramos ninguna coincidencia."
                  : "Que no haya casos no quiere decir que el patrón no exista: puede faltar el dato en los textos publicados."}
              </p>
            </div>
          ) : esHhi && hhi ? (
            <div className="tblwrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Organismo · año</th>
                    <th className="r">HHI</th>
                    <th>Principal proveedor</th>
                    <th className="r">Monto asignable</th>
                  </tr>
                </thead>
                <tbody>
                  {hhi.filas.map((c) => (
                    <tr key={`${c.organismo_id}-${c.anio}`}>
                      <td style={{ minWidth: 220 }}>
                        <Link href={`${rutaOrganismo(c.organismo_id)}?anio=${c.anio}`} className="enlace-fila">
                          {nombreOrganismo(c.organismo, c.organismo_id)} · {c.anio}
                        </Link>
                        <div className="note" style={{ fontSize: 12 }}>
                          {entero(c.proveedores)} {c.proveedores === 1 ? "proveedor" : "proveedores"} con CUIT
                        </div>
                      </td>
                      <td className="r num fw7">{entero(c.hhi)}</td>
                      <td style={{ fontSize: 13 }}>
                        {c.cuit_principal ? <Link href={rutaProveedor(c.cuit_principal)}>{c.razon_social ?? cuit(c.cuit_principal)}</Link> : "—"} · {porcentaje(c.pct_principal)}
                      </td>
                      <td className="r num fw6 nowrap">{monto(c.monto_total, "ARS")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : casos ? (
            <div className="tblwrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Caso</th>
                    <th>Organismo</th>
                    <th className="r">Monto</th>
                    <th>Por qué se marcó</th>
                    <th>Fuente</th>
                  </tr>
                </thead>
                <tbody>
                  {casos.filas.map((c) => {
                    const t = textoCaso(c, hayUmbrales);
                    return (
                      <tr key={`${c.codigo_proceso}-${c.cuit}-${c.fecha}`}>
                        <td style={{ minWidth: 220 }}>
                          <Link href={rutaProceso(c.codigo_proceso)} className="enlace-fila">
                            {c.tipo === "empresa-nueva" || c.tipo === "fraccionamiento" || c.tipo === "domicilio-compartido"
                              ? recortar(suavizarMayusculas(c.objeto), 80) || c.codigo_proceso
                              : recortar(t.titulo.split(": ")[0], 90)}
                          </Link>
                          <div className="codigo" style={{ marginTop: 3 }}>
                            {c.codigo_proceso} · {fecha(c.fecha)}
                          </div>
                          {c.cuit && c.tipo !== "domicilio-compartido" ? (
                            <div className="note" style={{ fontSize: 12 }}>
                              <Link href={rutaProveedor(c.cuit)}>{c.razon_social ?? cuit(c.cuit)}</Link>
                            </div>
                          ) : null}
                        </td>
                        <td style={{ fontSize: 13 }}>{c.organismo_id ? <Link href={rutaOrganismo(c.organismo_id)}>{nombreOrganismo(c.organismo, c.organismo_id)}</Link> : c.organismo}</td>
                        <td className="r num fw6 nowrap">{c.monto ? <Monto valor={c.monto} moneda={c.moneda} dudoso={c.monto_dudoso} /> : <span className="note">—</span>}</td>
                        <td style={{ fontSize: 13, color: "var(--ink2)", minWidth: 220 }}>
                          {c.tipo === "empresa-nueva" || c.tipo === "fraccionamiento" || c.tipo === "domicilio-compartido" ? `${t.titulo}. ` : ""}
                          {t.por}
                        </td>
                        <td>{c.url_norma ? <Fuente url={c.url_norma} fecha={c.fecha_acto} /> : <Link className="src" href={rutaProceso(c.codigo_proceso)}>Ver ficha</Link>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          <Paginacion pagina={f.pagina} total={total} porPagina={POR_PAGINA_LISTA} href={(p) => href({ pagina: p })} />
          <p className="note m0">
            Vista de origen: <span className="mono">{sel.vista}</span>. <Link href="/metodologia">Metodología completa y registro de cambios →</Link>
          </p>
        </section>
      </div>
    </>
  );
}
