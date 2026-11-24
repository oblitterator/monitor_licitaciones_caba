import Link from "next/link";
import Marco from "@/components/Marco";
import { Conf, Fuente, IconoInfo, Kpi, Monto, Senal, SelectorPesos } from "@/components/ui";
import {
  obtenerCobertura,
  obtenerKpis,
  obtenerRankingOrganismos,
  obtenerRankingProveedores,
  obtenerSenalesRecientes,
  obtenerUltimoBoletin,
  type ActoCorto,
} from "@/lib/datos";
import { cuit, entero, fecha, fechaConDia, fechaCorta, monto, porcentaje, recortar, suavizarMayusculas } from "@/lib/formato";
import { estadoAnios } from "@/lib/cobertura";
import { parsearPeriodo, queryPeriodo } from "@/lib/periodo";
import type { Params } from "@/lib/busqueda";
import { rutaOrganismo, rutaProceso, rutaProveedor } from "@/lib/sitio";
import { textoCaso } from "@/lib/textos-senal";

const GRUPOS_HOY: { id: string; label: string; etapas: string[] }[] = [
  { id: "llamado", label: "Llamados", etapas: ["llamado"] },
  { id: "preadjudicacion", label: "Preadjudicaciones", etapas: ["preadjudicacion"] },
  { id: "adjudicacion", label: "Adjudicaciones", etapas: ["adjudicacion"] },
  { id: "modif", label: "Prórrogas y ampliaciones", etapas: ["prorroga", "ampliacion", "modificacion", "rectificacion"] },
];

function ItemActo({ a }: { a: ActoCorto }) {
  const contenido = (
    <>
      <span className="col g6" style={{ minWidth: 0 }}>
        <span className="codigo">{a.codigo_proceso ?? "Sin código de proceso"}</span>
        <span className="item-obj">{recortar(suavizarMayusculas(a.objeto), 140) || "Objeto no identificado"}</span>
        <span style={{ fontSize: 13, color: "var(--muted)" }}>{a.organismo}</span>
      </span>
      <span className="item-der">
        <span className="num fw6 nowrap" style={{ fontSize: 15 }}>
          {a.monto_total ? (
            <Monto valor={a.monto_total} moneda={a.moneda} estimado={a.monto_origen === "suma_firmas"} dudoso={a.monto_dudoso} />
          ) : (
            <span className="note">Sin monto publicado</span>
          )}
        </span>
        <Conf nivel={a.confianza} />
      </span>
    </>
  );
  return a.codigo_proceso ? (
    <Link href={rutaProceso(a.codigo_proceso)} className="item-acto">
      {contenido}
    </Link>
  ) : (
    <div className="item-acto">{contenido}</div>
  );
}

export default async function Inicio({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const cob = await obtenerCobertura();
  const per = parsearPeriodo(sp, cob.primera, cob.ultima);
  const hayIpc = cob.ipc > 0;
  const constantes = hayIpc && sp.pesos === "constantes";
  const anios = estadoAnios(cob.meses);
  const mesesPeriodo = cob.meses.filter((m) => m.mes >= per.desde.slice(0, 7) && m.mes <= per.hasta.slice(0, 7) && m.actos > 0);
  const sinDatos = mesesPeriodo.length === 0;

  const [k, hoy, senales, rkOrg, rkProv] = await Promise.all([
    obtenerKpis(per.desde, per.hasta, constantes),
    obtenerUltimoBoletin(per.hasta < cob.ultima ? per.hasta : cob.ultima),
    obtenerSenalesRecientes(per.hasta < cob.ultima ? per.hasta : cob.ultima, 3),
    obtenerRankingOrganismos(per.desde, per.hasta, constantes, 5),
    obtenerRankingProveedores(per.desde, per.hasta, constantes, 5),
  ]);

  const q = (extra: Record<string, string>) => {
    const base = queryPeriodo(per);
    const u = new URLSearchParams(base.slice(1));
    for (const [a, b] of Object.entries(extra)) u.set(a, b);
    return "?" + u.toString();
  };
  const ultimoAnio = Number(cob.ultima.slice(0, 4));
  const pesos = constantes ? "pesos constantes del último mes con IPC" : "pesos corrientes";
  const enPeriodo = `desde=${per.desde}&hasta=${per.hasta}`;

  return (
    <Marco activo="inicio">
      <section className="cabecera">
        <div className="texto">
          <span className="kicker">Tablero · {per.etiqueta}</span>
          <h1 className="titulo xl">En qué gasta la Ciudad y a quién le compra</h1>
          <p className="bajada" style={{ maxWidth: 640 }}>
            Leemos el Boletín Oficial y ordenamos cada llamado, preadjudicación, adjudicación, prórroga y ampliación. Cada número de esta página lleva al documento de donde sale.
          </p>
        </div>
        <div className="col g10" style={{ alignItems: "flex-start" }}>
          <span className="kicker">Período</span>
          <div className="seg" role="group" aria-label="Período">
            <Link href={queryPeriodo({ tipo: "mes", desde: cob.ultima })} className={per.tipo === "mes" ? "on" : ""} aria-current={per.tipo === "mes" ? "true" : undefined}>
              Último mes
            </Link>
            <Link href={queryPeriodo({ tipo: "anio", anio: per.anio ?? ultimoAnio })} className={per.tipo === "anio" ? "on" : ""} aria-current={per.tipo === "anio" ? "true" : undefined}>
              Año {per.anio ?? ultimoAnio}
            </Link>
            <Link href={queryPeriodo({ tipo: "rango", desde: per.desde, hasta: per.hasta })} className={per.tipo === "rango" ? "on" : ""} aria-current={per.tipo === "rango" ? "true" : undefined}>
              Rango…
            </Link>
          </div>
          {per.tipo === "rango" ? (
            <form className="fila" action="/" style={{ alignItems: "flex-end" }}>
              <input type="hidden" name="periodo" value="rango" />
              <label className="field">
                Desde
                <input type="date" name="desde" defaultValue={per.desde} min={cob.primera} max={cob.ultima} />
              </label>
              <label className="field">
                Hasta
                <input type="date" name="hasta" defaultValue={per.hasta} min={cob.primera} max={cob.ultima} />
              </label>
              <button className="btn sec" type="submit">
                Aplicar
              </button>
            </form>
          ) : (
            <nav aria-label="Otros años" className="fila note" style={{ gap: 4 }}>
              <span>Otros años:</span>
              {anios.map((a) => (
                <Link key={a.anio} href={queryPeriodo({ tipo: "anio", anio: a.anio })} aria-current={per.tipo === "anio" && per.anio === a.anio ? "true" : undefined} style={{ padding: "12px 4px" }}>
                  {a.anio}
                  {a.estado === "sin" ? " (sin datos)" : ""}
                </Link>
              ))}
            </nav>
          )}
          {hayIpc ? (
            <>
              <span className="kicker" style={{ marginTop: 6 }}>
                Valores
              </span>
              <SelectorPesos hayIpc constantes={constantes} hrefCorrientes={q({ pesos: "corrientes" })} hrefConstantes={q({ pesos: "constantes" })} />
            </>
          ) : null}
        </div>
      </section>

      {sinDatos ? (
        <section className="box estado" aria-live="polite">
          <span className="kicker">Sin datos para el período</span>
          <h2 className="h3">Todavía no cargamos {per.etiqueta}</h2>
          <p className="p14">
            La base tiene actos de {cob.meses.filter((m) => m.actos > 0).length} meses entre el {fecha(cob.primera)} y el {fecha(cob.ultima)}. Esto no significa que no hubo contrataciones: significa que aún no procesamos esos boletines.
          </p>
          <Link href="/metodologia#cobertura">Ver estado de la carga →</Link>
        </section>
      ) : null}

      <section aria-labelledby="kpi-h" className="col g16">
        <h2 id="kpi-h" className="kicker m0">
          Indicadores del período
        </h2>
        <div className="kpis">
          <Kpi l="Procesos" v={entero(k.procesos)} fn={1} n="con actos publicados" vacio={sinDatos} />
          <Kpi
            l="Monto adjudicado"
            v={k.monto_ars ? monto(k.monto_ars, "ARS") : "—"}
            fn={2}
            n={`sobre ${entero(k.procesos_con_monto)} procesos con monto en ARS`}
            vacio={!k.monto_ars}
          />
          <Kpi
            l="Con oferta única"
            v={k.con_dato_ofertas ? porcentaje((100 * k.unica) / k.con_dato_ofertas) : "—"}
            fn={3}
            n={k.con_dato_ofertas ? `${entero(k.unica)} de ${entero(k.con_dato_ofertas)} con dato de ofertas` : "sin dato de ofertas en el período"}
            vacio={!k.con_dato_ofertas}
          />
          <Kpi
            l="Por excepción"
            v={k.con_procedimiento ? porcentaje((100 * k.excepcion) / k.con_procedimiento) : "—"}
            fn={4}
            n="contratación menor y directa"
            vacio={!k.con_procedimiento}
          />
          <Kpi l="Señales nuevas" v={entero(k.senales_nuevas)} fn={5} n={k.senales_hasta ? `del ${fecha(k.senales_desde)} al ${fecha(k.senales_hasta)}` : "últimos 7 días con datos"} />
        </div>
        <p className="note m0">
          Montos en {pesos}, moneda original ARS. Los procesos en USD se suman aparte y no se convierten
          {k.monto_usd ? ` (${monto(k.monto_usd, "USD")} en ${entero(k.procesos_usd)} procesos)` : ""}.
          {k.montos_dudosos ? ` ${entero(k.montos_dudosos)} montos improbables (posibles errores de lectura) quedan fuera de la suma.` : ""}{" "}
          <Link href="/metodologia">Cómo se calcula cada indicador</Link>
        </p>
      </section>

      <section className="dos">
        <div className="ancha col g18">
          <div className="entre">
            <h2 className="h2">Hoy en el Boletín</h2>
            <Link href={`/procesos?desde=${hoy.fecha ?? ""}&hasta=${hoy.fecha ?? ""}`} style={{ fontSize: 14 }}>
              Ver todas las publicaciones de ese día →
            </Link>
          </div>
          <div className="aviso-cel">
            <IconoInfo />
            <span>
              {hoy.fecha ? (
                <>
                  Último boletín con actos procesados: <strong>{fechaConDia(hoy.fecha)}</strong>.{" "}
                </>
              ) : (
                "Todavía no hay boletines procesados. "
              )}
              Los boletines posteriores se están cargando; cuando estén al día, acá vas a ver el del día.
            </span>
          </div>
          {GRUPOS_HOY.map((g) => {
            const items = hoy.actos.filter((a) => a.etapa && g.etapas.includes(a.etapa));
            if (items.length === 0) return null;
            return (
              <div key={g.id} className="col">
                <div className="grupo-cab">
                  <span className="kicker" style={{ color: "var(--ink)" }}>
                    {g.label}
                  </span>
                  <span className="tag">{items.length}</span>
                </div>
                {items.slice(0, 3).map((a) => (
                  <ItemActo key={a.id_norma} a={a} />
                ))}
                {items.length > 3 ? (
                  <Link className="note" style={{ padding: "12px 0" }} href={`/procesos?desde=${hoy.fecha}&hasta=${hoy.fecha}&etapa=${g.id === "modif" ? "modificacion" : g.id}`}>
                    Ver las {items.length} →
                  </Link>
                ) : null}
              </div>
            );
          })}
        </div>

        <aside aria-labelledby="sen-h" className="lateral col g16">
          <div className="entre">
            <h2 id="sen-h" className="h2">
              Señales de la semana
            </h2>
            <Link href="/senales" style={{ fontSize: 14 }}>
              Todas →
            </Link>
          </div>
          <p className="aviso-sol">
            <strong>Una señal es un motivo para mirar, no una conclusión.</strong> Sirve para priorizar la revisión y siempre tiene explicaciones legítimas posibles.
          </p>
          {senales.length === 0 ? <p className="note m0">No hay señales calculadas hasta esta fecha.</p> : null}
          {senales.map((s) => {
            const t = textoCaso(s, cob.umbrales > 0);
            return (
              <article key={`${s.tipo}-${s.codigo_proceso}-${s.cuit}`} className={`box tarjeta-senal${t.na ? " na" : ""}`}>
                <Senal tipo={s.tipo} na={t.na} />
                <Link href={rutaProceso(s.codigo_proceso)} className="tarjeta-tit">
                  {t.titulo}
                </Link>
                <p className="p14">{t.por}</p>
                <p className="note m0">
                  <strong style={{ color: "var(--ink2)" }}>Puede explicarse por:</strong> {t.leg.charAt(0).toLowerCase() + t.leg.slice(1)}
                </p>
                <div className="fila">
                  {s.url_norma ? <Fuente url={s.url_norma} fecha={s.fecha_acto} etiqueta={`PDF BO ${fechaCorta(s.fecha_acto)}`} /> : null}
                  <Link className="src" href={`/senales/${s.tipo}`}>
                    Metodología
                  </Link>
                </div>
              </article>
            );
          })}
        </aside>
      </section>

      <section className="grilla-2">
        <div className="col g14" style={{ minWidth: 0 }}>
          <h2 className="h2">Organismos que más adjudicaron</h2>
          {rkOrg.length === 0 ? (
            <p className="note m0">Sin adjudicaciones con monto en el período.</p>
          ) : (
            <div className="tblwrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 28 }}>#</th>
                    <th>Organismo</th>
                    <th className="r">Adjudicado</th>
                    <th style={{ width: "30%" }}>Participación</th>
                  </tr>
                </thead>
                <tbody>
                  {rkOrg.map((r, i) => (
                    <tr key={r.id}>
                      <td className="mono" style={{ color: "var(--muted)" }}>
                        {i + 1}
                      </td>
                      <td>
                        <Link href={rutaOrganismo(r.id)} className="enlace-fila">
                          {r.nombre}
                        </Link>
                        <div className="note" style={{ fontSize: 12 }}>
                          {entero(r.procesos)} {r.procesos === 1 ? "proceso adjudicado" : "procesos adjudicados"}
                        </div>
                      </td>
                      <td className="r num fw6 nowrap">{monto(r.monto, "ARS")}</td>
                      <td>
                        <div className="fila" style={{ flexWrap: "nowrap" }}>
                          <div className="bar" style={{ flex: 1 }}>
                            <span style={{ width: `${Number(r.pct ?? 0)}%` }} />
                          </div>
                          <span className="mono num" style={{ fontSize: 12, width: 48, textAlign: "right" }}>
                            {porcentaje(r.pct)}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="note m0">
            Cada unidad operativa de compras se cuenta por separado: el Boletín no informa a qué ministerio pertenece cada una. <Link href="/organismos">Todos los organismos</Link>
          </p>
        </div>
        <div className="col g14" style={{ minWidth: 0 }}>
          <h2 className="h2">Proveedores que más ganaron</h2>
          {rkProv.filas.length === 0 ? (
            <p className="note m0">Sin adjudicaciones con monto asignable en el período.</p>
          ) : (
            <div className="tblwrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 28 }}>#</th>
                    <th>Proveedor</th>
                    <th className="r">Adjudicado</th>
                    <th style={{ width: "30%" }}>Participación</th>
                  </tr>
                </thead>
                <tbody>
                  {rkProv.filas.map((r, i) => (
                    <tr key={r.id}>
                      <td className="mono" style={{ color: "var(--muted)" }}>
                        {i + 1}
                      </td>
                      <td>
                        <Link href={rutaProveedor(r.id)} className="enlace-fila">
                          {r.nombre ?? cuit(r.id)}
                        </Link>
                        <div className="note" style={{ fontSize: 12 }}>
                          CUIT <span className="mono">{cuit(r.id)}</span> · {entero(r.procesos)} {r.procesos === 1 ? "adjudicación" : "adjudicaciones"}
                        </div>
                      </td>
                      <td className="r num fw6 nowrap">{monto(r.monto, "ARS")}</td>
                      <td>
                        <div className="fila" style={{ flexWrap: "nowrap" }}>
                          <div className="bar" style={{ flex: 1 }}>
                            <span style={{ width: `${Number(r.pct ?? 0)}%` }} />
                          </div>
                          <span className="mono num" style={{ fontSize: 12, width: 48, textAlign: "right" }}>
                            {porcentaje(r.pct)}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="note m0">
            {rkProv.sinCuit.n > 0
              ? `${entero(rkProv.sinCuit.n)} adjudicaciones a firmas sin CUIT identificado${rkProv.sinCuit.monto ? ` (${monto(rkProv.sinCuit.monto, "ARS")})` : ""} no figuran en el ranking hasta revisarlas. `
              : ""}
            <Link href="/proveedores">Todos los proveedores</Link>
          </p>
        </div>
      </section>

      <section id="fuentes" className="fuentes">
        <h2 className="kicker m0">Notas y fuentes</h2>
        <ol className="note" style={{ gap: 4, fontSize: 13 }}>
          <li>
            Procesos con al menos un acto publicado en el Boletín Oficial en el período. <Link href={`/procesos?${enPeriodo}`}>Ver listado</Link>.
          </li>
          <li>Monto de la última adjudicación de cada proceso adjudicado en el período, en ARS. Excluye procesos sin monto identificado y montos improbables. Incluye montos estimados, marcados con línea punteada en cada ficha.</li>
          <li>Procesos con oferta única sobre los procesos del período en los que el texto informa la cantidad de ofertas.</li>
          <li>Contratación menor y contratación directa sobre el total de procesos del período con procedimiento identificado.</li>
          <li>
            Casos de señal por proceso (oferta única, modificaciones, empresa nueva, domicilio compartido y posible fraccionamiento) con fecha en los últimos 7 días con datos del período. <Link href="/senales">Cómo se calculan</Link>.
          </li>
        </ol>
      </section>
    </Marco>
  );
}
