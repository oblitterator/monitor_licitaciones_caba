import Link from "next/link";
import type { ReactNode } from "react";
import { entero, fechaCorta, millones, monto as fmtMonto, type Numerico } from "@/lib/formato";
import { nombreSenal } from "@/lib/catalogo";

export type Nivel = "alta" | "media" | "baja";

export function Conf({ nivel, largo = false, children }: { nivel: Nivel; largo?: boolean; children?: ReactNode }) {
  const txt = largo ? `Confianza ${nivel} en la extracción` : `Confianza ${nivel}`;
  return (
    <span className={`conf ${nivel}`}>
      <b aria-hidden="true">
        <i />
        <i />
        <i />
      </b>
      {children ?? txt}
    </span>
  );
}

/** Píldora de señal. Siempre amarilla; `na` = no calculable. */
export function Senal({ tipo, na = false, href, children }: { tipo?: string; na?: boolean; href?: string; children?: ReactNode }) {
  const txt = children ?? (tipo ? nombreSenal(tipo) : "");
  const cls = na ? "senal na" : "senal";
  return href ? (
    <Link className={cls} href={href}>
      {txt}
    </Link>
  ) : (
    <span className={cls}>{txt}</span>
  );
}

/** Enlace al PDF del Boletín; si no hay URL, el estado "no disponible". */
export function Fuente({ url, fecha, etiqueta }: { url: string | null | undefined; fecha?: string | null; etiqueta?: string }) {
  const txt = etiqueta ?? (fecha ? `BO ${fechaCorta(fecha)}` : "PDF");
  if (!url) return <span className="src off">{txt} · PDF no disponible</span>;
  const https = url.replace(/^http:\/\//, "https://");
  return (
    <a className="src" href={https} target="_blank" rel="noopener noreferrer">
      {txt} <span aria-hidden="true">↗</span>
      <span className="sr"> (PDF, abre en una pestaña nueva)</span>
    </a>
  );
}

/**
 * Monto con sus marcas: estimado (punteado), dudoso (no se suma) y extraído con IA.
 */
export function Monto({
  valor,
  moneda,
  estimado = false,
  dudoso = false,
  ia,
  signo = "",
}: {
  valor: Numerico;
  moneda: string | null | undefined;
  estimado?: boolean;
  dudoso?: boolean;
  ia?: { cita?: string | null; modelo?: string | null } | null;
  signo?: string;
}) {
  if (valor === null || valor === undefined || valor === "") return <span className="note">Sin monto</span>;
  const txt = signo + (estimado ? "≈ " : "") + fmtMonto(valor, moneda ?? "ARS");
  return (
    <>
      <span
        className={estimado || dudoso ? "est" : undefined}
        title={dudoso ? "Monto improbable: posible error de lectura. No se suma en los totales." : estimado ? "Monto estimado: suma de los montos por firma, no un total publicado." : undefined}
      >
        {txt}
      </span>
      {dudoso ? <span className="tag" style={{ marginLeft: 6 }}>a revisar</span> : null}
      {ia ? <IaEtiqueta cita={ia.cita} modelo={ia.modelo} /> : null}
    </>
  );
}

/** "extraído con IA", con la cita textual del PDF en una ventana desplegable (sin JS). */
export function IaEtiqueta({ cita, modelo }: { cita?: string | null; modelo?: string | null }) {
  return (
    <details className="ia">
      <summary>
        Extraído con IA<span className="sr">: ver la cita del documento</span>
      </summary>
      <div className="ia-cita" role="note">
        {cita ? (
          <>
            <strong>Cita del PDF:</strong> “{cita}”
          </>
        ) : (
          "El modelo completó este dato y la cita se verificó contra el texto del PDF."
        )}
        <br />
        <span className="note">
          Lo completó un modelo de lenguaje{modelo ? ` (${modelo})` : ""} porque las reglas no lo encontraron. Verificá en el PDF antes de citar.
        </span>
      </div>
    </details>
  );
}

export function Kpi({ l, v, n, fn, vacio = false }: { l: string; v: ReactNode; n?: ReactNode; fn?: number; vacio?: boolean }) {
  return (
    <div className="kpi">
      <span className="kpi-l">{l}</span>
      <span className={vacio ? "kpi-v vacio" : "kpi-v"}>
        {v}
        {fn ? (
          <a className="fn" href="#fuentes" aria-label={`Nota ${fn}`}>
            [{fn}]
          </a>
        ) : null}
      </span>
      {n ? <span className="kpi-n">{n}</span> : null}
    </div>
  );
}

export function Ruta({ items }: { items: { href?: string; label: ReactNode }[] }) {
  return (
    <nav aria-label="Ruta" className="ruta">
      <ol>
        {items.map((it, i) => (
          <li key={i}>{it.href ? <Link href={it.href}>{it.label}</Link> : <span aria-current="page">{it.label}</span>}</li>
        ))}
      </ol>
    </nav>
  );
}

export function IconoInfo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1B5A92" strokeWidth="2" aria-hidden="true" style={{ flex: "none", marginTop: 2 }}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16.5v.5" />
    </svg>
  );
}

export type Barra = { anio: number; valor: number | null; estado: "completo" | "parcial" | "sin"; nota?: string };

/**
 * Barras por año. Los años sin datos se rayan en gris; los incompletos, en celeste rayado.
 * Nunca se dibuja un cero donde falta el dato.
 */
export function BarrasAnio({ barras, etiqueta, alto = 200 }: { barras: Barra[]; etiqueta: string; alto?: number }) {
  const max = Math.max(1, ...barras.map((b) => b.valor ?? 0));
  return (
    <>
      <figure className="barras" role="img" aria-label={etiqueta}>
        {barras.map((b) => {
          const h = b.estado === "sin" ? Math.round(alto * 0.35) : Math.max(2, Math.round(((b.valor ?? 0) / max) * alto));
          return (
            <div className="barra-col" key={b.anio}>
              <span className="barra-val num">{b.estado === "sin" ? "sin datos" : b.valor === null ? "—" : millones(b.valor)}</span>
              <div className={`barra ${b.estado === "completo" ? "" : b.estado}`} style={{ height: h }} />
            </div>
          );
        })}
      </figure>
      <div className="barras-ejes" aria-hidden="true">
        {barras.map((b) => (
          <span key={b.anio}>{b.anio}</span>
        ))}
      </div>
    </>
  );
}

export function LeyendaBarras() {
  return (
    <div className="leyenda">
      <span>
        <span className="cuadro" style={{ background: "var(--celdeep)" }} />
        Año completo
      </span>
      <span>
        <span className="cuadro" style={{ background: "var(--rayado-dato)" }} />
        Año con datos parciales
      </span>
      <span>
        <span className="cuadro" style={{ background: "var(--rayado)", border: "1px solid var(--rule)" }} />
        Sin datos cargados
      </span>
    </div>
  );
}

/** Pesos corrientes / constantes. Se oculta mientras ref.ipc esté vacío. */
export function SelectorPesos({ hayIpc, constantes, hrefCorrientes, hrefConstantes }: { hayIpc: boolean; constantes: boolean; hrefCorrientes: string; hrefConstantes: string }) {
  if (!hayIpc) return null;
  return (
    <div className="seg" role="group" aria-label="Tipo de pesos">
      <Link className={constantes ? "" : "on"} href={hrefCorrientes} aria-current={constantes ? undefined : "true"}>
        Pesos corrientes
      </Link>
      <Link className={constantes ? "on" : ""} href={hrefConstantes} aria-current={constantes ? "true" : undefined}>
        Pesos constantes
      </Link>
    </div>
  );
}

export function Paginacion({ pagina, total, porPagina, href }: { pagina: number; total: number; porPagina: number; href: (p: number) => string }) {
  const paginas = Math.max(1, Math.ceil(total / porPagina));
  if (total === 0) return null;
  const desde = (pagina - 1) * porPagina + 1;
  const hasta = Math.min(total, pagina * porPagina);
  const vecinas = [pagina - 2, pagina - 1, pagina, pagina + 1, pagina + 2].filter((p) => p >= 1 && p <= paginas);
  return (
    <nav aria-label="Páginas" className="paginas">
      <span className="note">
        Mostrando {entero(desde)}–{entero(hasta)} de {entero(total)}
      </span>
      <div className="fila" style={{ gap: 6 }}>
        {pagina > 1 ? (
          <Link className="btn sec" href={href(pagina - 1)} rel="prev">
            ← Anterior
          </Link>
        ) : null}
        {vecinas.map((p) => (
          <Link key={p} className={p === pagina ? "btn" : "btn sec"} href={href(p)} aria-current={p === pagina ? "page" : undefined} aria-label={`Página ${p}`}>
            {p}
          </Link>
        ))}
        {pagina < paginas ? (
          <Link className="btn sec" href={href(pagina + 1)} rel="next">
            Siguiente →
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
