import type { Metadata } from "next";
import Link from "next/link";
import Marco from "@/components/Marco";
import { Conf } from "@/components/ui";
import { obtenerCalidad, obtenerCobertura } from "@/lib/datos";
import { describirHuecos, serieMeses } from "@/lib/cobertura";
import { entero, fecha, mesAnio, monto, numero, porcentaje } from "@/lib/formato";

export const metadata: Metadata = {
  title: "Metodología y cobertura",
  description: "De dónde salen los datos, qué período cubren, qué tan completa es la extracción y cómo pedir una corrección.",
  alternates: { canonical: "/metodologia" },
};

const ESTADO_DOC: Record<string, string> = { ok: "Con texto extraído", pendiente: "Pendientes de descargar o leer", vacio: "Sin texto (probablemente escaneados)", error: "Con error de descarga" };
const RESOL: Record<string, string> = {
  cuit_en_texto: "CUIT escrito en el propio acto",
  alias: "Alias aprendido o manual",
  padron_exacto: "Padrón: nombre exacto",
  padron_base: "Padrón: nombre sin forma societaria",
  padron_trgm: "Padrón: nombre parecido (trigramas)",
  sin_resolver: "Sin resolver",
  sin_correr: "Resolución no corrida",
};

export default async function Metodologia() {
  const [cob, q] = await Promise.all([obtenerCobertura(), obtenerCalidad()]);
  const hoy = new Date().toISOString().slice(0, 7);
  const serie = serieMeses(cob.meses, hoy);
  const cargados = serie.filter((s) => s.con).length;
  const huecos = describirHuecos(serie);
  const p = q.parser;
  const pct = (n: number) => (p.actos ? (100 * n) / p.actos : 0);
  const docsTot = q.docs.reduce((a, d) => a + d.documentos, 0);
  const docsOk = q.docs.find((d) => d.estado === "ok")?.documentos ?? 0;
  const firmasTot = q.resol.reduce((a, r) => a + r.firmas, 0);
  const firmasCuit = q.resol.filter((r) => !["sin_resolver", "sin_correr"].includes(r.resolucion)).reduce((a, r) => a + r.firmas, 0);
  const etiquetasEje = serie.filter((s, i) => i === 0 || s.mes.endsWith("-01") || i === serie.length - 1);

  return (
    <Marco activo="metodologia" angosto>
      <header className="col g12" style={{ borderBottom: "2px solid var(--ink)", paddingBottom: 28 }}>
        <span className="kicker">Metodología y cobertura</span>
        <h1 className="titulo xl">Qué sabemos, qué no, y cómo lo sabemos</h1>
        <p className="m0" style={{ fontSize: 18, lineHeight: 1.6, color: "var(--ink2)" }}>
          Este sitio es tan bueno como sus datos. Acá publicamos de dónde salen, qué tan completos están y cómo pedir una corrección. Todos los números de esta página se calculan en vivo sobre la base.
        </p>
      </header>

      <section className="col g16">
        <h2 className="h2">Fuentes</h2>
        <div className="tarjetas" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
          <div className="box col g8" style={{ padding: 20 }}>
            <span className="h3">Boletín Oficial de la Ciudad</span>
            <p className="p14">
              Fuente principal. Leemos cada edición y extraemos automáticamente los actos de contratación: llamados, aperturas, preadjudicaciones, adjudicaciones, prórrogas y ampliaciones. Hoy: {entero(p.actos)} actos de{" "}
              {entero(docsTot)} publicaciones de la sección Licitaciones.
            </p>
          </div>
          <div className="box col g8" style={{ padding: 20 }}>
            <span className="h3">Buenos Aires Compras</span>
            <p className="p14">
              Complementa códigos de proceso y datos de los pliegos cuando el Boletín no los trae.{" "}
              {cob.bac ? `${entero(cob.bac)} procesos cargados.` : <strong>Todavía no está cargado en esta base.</strong>}
            </p>
          </div>
          <div className="box col g8" style={{ padding: 20 }}>
            <span className="h3">Padrón de empresas</span>
            <p className="p14">
              {numero(q.padron / 1e6, 2)} millones de empresas del Registro Nacional de Sociedades, para vincular cada firma con su CUIT, fecha de constitución y domicilio fiscal.
            </p>
          </div>
        </div>
      </section>

      <section id="cobertura" className="col g16">
        <h2 className="h2">Período cubierto</h2>
        <div className="col g8">
          <div className="cobertura" role="img" aria-label={`Meses con actos cargados entre ${mesAnio(cob.primera)} y hoy: ${cargados} de ${serie.length}. Sin datos: ${huecos.join(", ")}.`}>
            {serie.map((s) => (
              <span key={s.mes} className={s.con ? undefined : "sin"} title={`${s.mes.slice(5)}/${s.mes.slice(0, 4)}: ${s.con ? "cargado" : "sin datos"}`} />
            ))}
          </div>
          <div className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)" }}>
            {etiquetasEje.map((s, i) => (
              <span key={s.mes}>{i === etiquetasEje.length - 1 ? "hoy" : i === 0 ? `${s.mes.slice(5)}/${s.mes.slice(0, 4)}` : s.mes.slice(0, 4)}</span>
            ))}
          </div>
          <div className="leyenda" style={{ fontSize: 14 }}>
            <span>
              <span className="cuadro" style={{ background: "var(--celdeep)" }} />
              Cargado · {entero(cargados)} meses
            </span>
            <span>
              <span className="cuadro" style={{ background: "var(--rayado)", border: "1px solid var(--rule)" }} />
              Sin datos o en carga · {entero(serie.length - cargados)} meses
            </span>
          </div>
        </div>
        <p className="p14">
          Actos cargados del {fecha(cob.primera)} al {fecha(cob.ultima)}. Publicaciones de Licitaciones registradas hasta el {fecha(cob.norma_ultima)}, pero sin texto procesado después de {mesAnio(cob.ultima)}.
          {huecos.length ? ` Huecos: ${huecos.join("; ")}.` : ""}
        </p>
        <div className="tblwrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Año</th>
                <th className="r">Publicaciones de Licitaciones</th>
                <th className="r">Con texto procesado</th>
                <th className="r">Actos</th>
                <th className="r">Confianza alta</th>
                <th className="r">Con monto</th>
              </tr>
            </thead>
            <tbody>
              {q.licitacionesPorAnio.map((l) => {
                const a = q.porAnio.find((x) => x.anio === l.anio);
                return (
                  <tr key={l.anio}>
                    <td className="mono">{l.anio}</td>
                    <td className="r num">{entero(l.licitaciones)}</td>
                    <td className="r num">
                      {entero(l.con_texto)} <span className="note">({porcentaje(l.licitaciones ? (100 * l.con_texto) / l.licitaciones : 0, 0)})</span>
                    </td>
                    <td className="r num">{a ? entero(a.actos) : <span className="note">sin datos</span>}</td>
                    <td className="r num">{a ? porcentaje(a.pct_alta) : "—"}</td>
                    <td className="r num">{a ? porcentaje(a.pct_con_monto) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="note m0">Un período sin datos no significa que no hubo contrataciones: significa que todavía no procesamos esos boletines. En el sitio lo marcamos siempre así, rayado.</p>
      </section>

      <section id="confianza" className="col g16">
        <h2 className="h2">Calidad de la extracción</h2>
        <div className="kpis" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
          <div className="kpi">
            <span className="kpi-l">Actos parseados</span>
            <span className="kpi-v" style={{ fontSize: 34 }}>
              {entero(p.actos)}
            </span>
          </div>
          <div className="kpi">
            <span className="kpi-l">Documentos procesados</span>
            <span className="kpi-v" style={{ fontSize: 34 }}>
              {porcentaje(docsTot ? (100 * docsOk) / docsTot : 0, 0)}
            </span>
            <span className="kpi-n">
              {entero(docsOk)} de {entero(docsTot)}
            </span>
          </div>
          <div className="kpi">
            <span className="kpi-l">Firmas por acto</span>
            <span className="kpi-v" style={{ fontSize: 34 }}>
              {entero(firmasTot)}
            </span>
            <span className="kpi-n">menciones de firmas en los actos</span>
          </div>
          <div className="kpi">
            <span className="kpi-l">Firmas con CUIT</span>
            <span className="kpi-v" style={{ fontSize: 34 }}>
              {porcentaje(firmasTot ? (100 * firmasCuit) / firmasTot : 0, 0)}
            </span>
            <span className="kpi-n">
              {entero(firmasCuit)} de {entero(firmasTot)}
            </span>
          </div>
        </div>
        <div className="col g8">
          <span style={{ fontSize: 14, fontWeight: 600 }}>Actos por nivel de confianza</span>
          <div className="apilada" aria-hidden="true">
            <span style={{ flex: pct(p.alta), background: "var(--ink)" }} />
            <span style={{ flex: pct(p.media), background: "var(--muted)" }} />
            <span style={{ flex: pct(p.baja), background: "repeating-linear-gradient(135deg, var(--baja) 0 4px, var(--bajawash) 4px 8px)" }} />
          </div>
          <div className="leyenda" style={{ fontSize: 14 }}>
            <Conf nivel="alta">Alta · {porcentaje(pct(p.alta), 0)}</Conf>
            <Conf nivel="media">Media · {porcentaje(pct(p.media), 0)}</Conf>
            <Conf nivel="baja">Baja · {porcentaje(pct(p.baja), 0)}</Conf>
          </div>
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th>Nivel</th>
              <th>Qué significa</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <Conf nivel="alta">Alta</Conf>
              </td>
              <td>Los campos clave (código de proceso, etapa, monto y firmas) se leyeron de forma explícita y son consistentes entre sí.</td>
            </tr>
            <tr>
              <td>
                <Conf nivel="media">Media</Conf>
              </td>
              <td>Falta algún campo o hubo que inferirlo del contexto del documento.</td>
            </tr>
            <tr>
              <td>
                <Conf nivel="baja">Baja</Conf>
              </td>
              <td>El documento tiene un formato difícil, los totales no coinciden o faltan varios campos. Revisá el PDF antes de citar.</td>
            </tr>
          </tbody>
        </table>
        <div className="tarjetas">
          <div className="box col g8" style={{ padding: 18 }}>
            <span className="kicker">Campos leídos</span>
            <p className="p14">
              Código de proceso en {porcentaje(pct(p.con_codigo), 0)} de los actos; monto en {porcentaje(pct(p.con_monto), 0)}. En {entero(p.conflicto)} actos el nombre de la norma y el título del texto no coinciden en la etapa.
            </p>
          </div>
          <div className="box col g8" style={{ padding: 18 }}>
            <span className="kicker">CUIT de las firmas</span>
            <ul className="p14" style={{ margin: 0, paddingLeft: 18 }}>
              {q.resol.map((r) => (
                <li key={r.resolucion}>
                  {RESOL[r.resolucion] ?? r.resolucion}: {entero(r.firmas)}
                </li>
              ))}
            </ul>
          </div>
          <div className="box col g8" style={{ padding: 18 }}>
            <span className="kicker">Controles</span>
            <p className="p14">
              {entero(q.pendientes.n)} firmas ganadoras sin CUIT ({entero(q.pendientes.actos)} actos{q.pendientes.monto ? `, ≈ ${monto(q.pendientes.monto, "ARS")}` : ""}) en revisión. {entero(q.controlMontos)} actos donde la suma por firma no coincide con el total publicado.
            </p>
          </div>
          <div className="box col g8" style={{ padding: 18 }}>
            <span className="kicker">Documentos</span>
            <ul className="p14" style={{ margin: 0, paddingLeft: 18 }}>
              {q.docs.map((d) => (
                <li key={d.estado}>
                  {ESTADO_DOC[d.estado] ?? d.estado}: {entero(d.documentos)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section id="ia" className="col g12">
        <h2 className="h2">Datos completados con IA</h2>
        <p className="p15">
          En los actos de confianza media o baja, un modelo de lenguaje puede completar los campos que las reglas no encontraron (etapa, código, monto, firmas). Solo se acepta un valor si viene con una cita textual que está en el PDF y lo contiene; las reglas siempre mandan y nunca se pisan. En el sitio esos valores llevan la marca{" "}
          <span className="tag ia">Extraído con IA</span> con la cita.
        </p>
        <p className="note m0">
          {q.llm.con_llm
            ? `Hoy: ${entero(q.llm.con_llm)} de ${entero(q.llm.actos)} actos de confianza media o baja tienen extracción verificada; completó ${entero(q.llm.codigo)} códigos, ${entero(q.llm.monto)} montos y ${entero(q.llm.etapa)} etapas.`
            : `Todavía no se corrió sobre esta base: ninguno de los ${entero(q.llm.actos)} actos de confianza media o baja tiene valores completados con IA.`}
        </p>
      </section>

      <section className="col g12">
        <h2 className="h2">Lo que todavía no está</h2>
        <ul className="p15" style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 8 }}>
          {cob.ipc === 0 ? (
            <li>
              <strong>Ajuste por IPC.</strong> Sin él no mostramos pesos constantes y desaconsejamos comparar montos entre años.
            </li>
          ) : null}
          {cob.umbrales === 0 ? (
            <li>
              <strong>Topes por procedimiento.</strong> Sin ellos la señal de posible fraccionamiento no se puede calcular.
            </li>
          ) : null}
          {cob.bac === 0 ? (
            <li>
              <strong>Buenos Aires Compras.</strong> Los snapshots del OCDS todavía no están cargados.
            </li>
          ) : null}
          {cob.boletines === 0 ? (
            <li>
              <strong>Datos de cada edición del Boletín.</strong> Las normas vienen de la versión anterior del sistema, sin número de boletín: por eso citamos la fecha de publicación y el PDF de cada norma.
            </li>
          ) : null}
          <li>
            <strong>Boletines desde {mesAnio(cob.ultima)}.</strong> En carga.
          </li>
        </ul>
      </section>

      <section className="aviso-sol col g10" style={{ padding: 24 }}>
        <h2 className="h3" style={{ color: "var(--solink)" }}>
          Advertencia sobre las señales
        </h2>
        <p className="m0" style={{ fontSize: 15, lineHeight: 1.6 }}>
          Las señales son indicadores estadísticos que ayudan a priorizar qué revisar. No son acusaciones ni prueban irregularidades. Cada una puede tener razones legítimas, y siempre las publicamos junto a la señal.
        </p>
        <Link href="/senales" style={{ fontSize: 14 }}>
          Método de cada señal →
        </Link>
      </section>

      <section id="correcciones" className="grilla-2" style={{ gap: 32 }}>
        <div className="col g12">
          <h2 className="h2">Pedir una corrección</h2>
          <ol className="p15" style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 8 }}>
            <li>
              En cualquier ficha de proceso o legajo de proveedor, tocá <strong>Reportar un error en este dato</strong>.
            </li>
            <li>Indicá el campo y, si podés, el documento que lo respalda.</li>
            <li>
              Lo revisamos en <em>[plazo a definir]</em> días hábiles y, si dejaste un mail, te respondemos.
            </li>
            <li>Si corregimos, queda registrado con fecha en el registro de cambios.</li>
          </ol>
        </div>
        <div id="replica" className="col g12">
          <h2 className="h2">Derecho a réplica</h2>
          <p className="p15">
            Empresas y organismos mencionados pueden enviar una aclaración desde su legajo. Si aporta contexto verificable, la publicamos al lado del dato o de la señal, con fecha y firma.
          </p>
          <Link className="btn sec" href="/proveedores" style={{ alignSelf: "flex-start" }}>
            Buscar el legajo
          </Link>
        </div>
      </section>

      <section id="datos" className="col g12">
        <h2 className="h2">Datos personales</h2>
        <p className="p15">
          Para las alertas guardamos solo el mail y lo que elegiste seguir; para los reportes, el mensaje y el mail si lo dejaste. No los compartimos. Responsable y contacto: <em>[a definir]</em>.
        </p>
      </section>

      <section id="cambios" className="col g12">
        <h2 className="h2">Registro de cambios</h2>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 140 }}>Fecha</th>
              <th>Cambio</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono num" style={{ fontSize: 13 }}>
                <em>[fecha]</em>
              </td>
              <td>
                Primera publicación de la base: {mesAnio(cob.primera)} a {mesAnio(cob.ultima)}.
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </Marco>
  );
}
