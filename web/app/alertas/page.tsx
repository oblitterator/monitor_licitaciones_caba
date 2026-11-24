import type { Metadata } from "next";
import Link from "next/link";
import Marco from "@/components/Marco";
import { AlertaForm } from "@/components/AlertaForm";
import { obtenerUltimoBoletin, obtenerCobertura } from "@/lib/datos";
import { etapa } from "@/lib/catalogo";
import { fecha, monto, recortar, suavizarMayusculas } from "@/lib/formato";
import { rutaProceso } from "@/lib/sitio";
import { turnstileSiteKey } from "@/lib/turnstile";
import type { Params } from "@/lib/busqueda";

export const metadata: Metadata = {
  title: "Alertas por mail",
  description: "Seguí una palabra, un organismo, un proveedor o un tipo de señal y recibí un resumen diario con lo nuevo del Boletín Oficial.",
  alternates: { canonical: "/alertas" },
};

const uno = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function Alertas({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const cob = await obtenerCobertura();
  const hoy = await obtenerUltimoBoletin(cob.ultima);
  const ejemplos = hoy.actos.filter((a) => a.codigo_proceso && a.objeto).slice(0, 3);
  return (
    <Marco activo="alertas">
      <div className="fila" style={{ gap: 48, alignItems: "flex-start" }}>
        <section className="col g24" style={{ flex: "999 1 540px", minWidth: 0 }}>
          <div className="col g12" style={{ borderBottom: "2px solid var(--ink)", paddingBottom: 24 }}>
            <span className="kicker">Alertas · piloto por mail</span>
            <h1 className="titulo">Enterate primero, sin leer el Boletín entero</h1>
            <p className="bajada">Elegí qué seguir y te mandamos un resumen diario con lo nuevo. Cada ítem lleva a la ficha del proceso y al PDF.</p>
          </div>
          <AlertaForm siteKey={turnstileSiteKey()} tipoInicial={uno(sp.tipo)} valorInicial={uno(sp.valor).slice(0, 200)} />
          <p className="note m0" style={{ paddingTop: 12, borderTop: "1px solid var(--rule2)" }}>
            Usamos tu mail solo para mandarte esta alerta. No lo compartimos ni lo usamos para otra cosa. <Link href="/metodologia#datos">Política de datos</Link>
          </p>
        </section>

        <aside aria-label="Vista previa del resumen" className="col g12" style={{ flex: "1 1 420px", minWidth: 0 }}>
          <span className="kicker">Así se ve el resumen</span>
          <div className="mail">
            <div className="flag" />
            <div className="col g4" style={{ padding: "18px 20px", borderBottom: "1px solid var(--rule2)" }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
                De: Monitor de Licitaciones CABA
              </span>
              <span style={{ fontSize: 16, fontWeight: 700 }}>
                {ejemplos.length} novedades · Boletín del {fecha(hoy.fecha)}
              </span>
            </div>
            <div className="col" style={{ padding: "8px 20px 20px" }}>
              {ejemplos.map((i) => (
                <div key={i.id_norma} className="col g6" style={{ padding: "14px 0", borderBottom: "1px solid var(--rule2)" }}>
                  <div className="fila">
                    <span className="tag">{etapa(i.etapa)}</span>
                    <span className="codigo">{i.codigo_proceso}</span>
                  </div>
                  <Link href={rutaProceso(i.codigo_proceso!)} className="enlace-fila" style={{ fontSize: 15, lineHeight: 1.35 }}>
                    {recortar(suavizarMayusculas(i.objeto), 100)}
                  </Link>
                  <span className="note">
                    {i.organismo} ·{" "}
                    <strong className="num" style={{ color: "var(--ink)" }}>
                      {i.monto_total ? monto(i.monto_total, i.moneda) : "Sin monto publicado"}
                    </strong>
                  </span>
                </div>
              ))}
              <p className="note" style={{ margin: "14px 0 0" }}>
                Las señales que aparezcan en tu resumen son indicadores para revisar, no conclusiones. <Link href="/senales">Qué significan</Link>
              </p>
            </div>
          </div>
          <p className="note m0">Ejemplo armado con publicaciones reales del último boletín procesado.</p>
        </aside>
      </div>
    </Marco>
  );
}
