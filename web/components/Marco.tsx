import Link from "next/link";
import type { ReactNode } from "react";
import { obtenerCobertura } from "@/lib/datos";
import { fecha, mesAnio } from "@/lib/formato";

export type Seccion = "inicio" | "procesos" | "proveedores" | "organismos" | "senales" | "alertas" | "metodologia" | null;

const NAV: [Exclude<Seccion, null>, string, string][] = [
  ["inicio", "Inicio", "/"],
  ["procesos", "Procesos", "/procesos"],
  ["proveedores", "Proveedores", "/proveedores"],
  ["organismos", "Organismos", "/organismos"],
  ["senales", "Señales", "/senales"],
  ["alertas", "Alertas", "/alertas"],
  ["metodologia", "Metodología", "/metodologia"],
];

function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 34 34" aria-hidden="true">
      <rect width="34" height="34" rx="4" fill="#0F1D2E" />
      <rect x="8" y="10" width="18" height="2.4" fill="#FFFFFF" />
      <rect x="8" y="16" width="12" height="2.4" fill="#74ACDF" />
      <rect x="8" y="22" width="15" height="2.4" fill="#FFFFFF" />
      <circle cx="25" cy="22.6" r="3.2" fill="#F6B40E" />
    </svg>
  );
}

function Lupa({ color = "#FFFFFF" }: { color?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

async function Encabezado({ activo }: { activo: Seccion }) {
  const cob = await obtenerCobertura();
  return (
    <header className="cab">
      <a className="saltar" href="#contenido">
        Saltar al contenido
      </a>
      <div className="flag" />
      <div className="cab-fila">
        <Link href="/" className="marca" aria-label="Monitor de Licitaciones CABA, inicio">
          <Logo />
          <span className="marca-txt">
            <span className="marca-nom">Monitor de Licitaciones</span>
            <span className="marca-sub">CABA · BOLETÍN OFICIAL</span>
          </span>
        </Link>
        <nav aria-label="Principal" className="nav">
          {NAV.map(([id, label, href]) => (
            <Link key={id} href={href} aria-current={id === activo ? "page" : undefined}>
              {label}
            </Link>
          ))}
        </nav>
        <form role="search" action="/procesos" className="busq-top">
          <label htmlFor="q-top" className="sr">
            Buscar
          </label>
          <input id="q-top" name="q" type="search" placeholder="Empresa, CUIT, organismo, expediente…" />
          <button type="submit" className="btn-icono" aria-label="Buscar">
            <Lupa />
          </button>
        </form>
        <div className="menu-movil-grupo solo-movil">
          <Link href="/procesos" className="icono-movil" aria-label="Buscar procesos">
            <Lupa color="#0F1D2E" />
          </Link>
          <details className="menu-movil">
            <summary aria-label="Menú">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0F1D2E" strokeWidth="2" aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </summary>
          <div className="menu-panel">
            <form role="search" action="/procesos">
              <label htmlFor="q-movil" className="sr">
                Buscar
              </label>
              <input id="q-movil" name="q" type="search" placeholder="Empresa, CUIT, expediente…" />
              <button type="submit" className="btn-icono" aria-label="Buscar">
                <Lupa />
              </button>
            </form>
            <nav aria-label="Principal (celular)">
              {NAV.map(([id, label, href]) => (
                <Link key={id} href={href} aria-current={id === activo ? "page" : undefined}>
                  {label}
                </Link>
              ))}
            </nav>
          </div>
          </details>
        </div>
      </div>
      <div className="cab-aviso">
        <div>
          <span className="fila" style={{ gap: 8 }}>
            <span aria-hidden="true" className="punto" />
            <span>
              <strong className="fw6">
                Base con datos del {mesAnio(cob.primera)} al {mesAnio(cob.ultima)}.
              </strong>{" "}
              <span className="solo-escritorio">La carga del período restante está en curso. </span>
              <Link href="/metodologia#cobertura">Ver cobertura</Link>
            </span>
          </span>
          <span className="mono solo-escritorio" style={{ fontSize: 12, color: "var(--muted)" }}>
            Proyecto independiente · no es un sitio del GCBA
          </span>
        </div>
      </div>
    </header>
  );
}

async function Pie() {
  const cob = await obtenerCobertura();
  return (
    <footer className="pie">
      <div className="flag" />
      <div className="pie-grilla">
        <div className="pie-col" style={{ gap: 10 }}>
          <span className="serif" style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>
            Monitor de Licitaciones CABA
          </span>
          <p className="m0" style={{ fontSize: 14, lineHeight: 1.55 }}>
            Proyecto independiente. No es un sitio del Gobierno de la Ciudad. Los datos se extraen del Boletín Oficial de la Ciudad de Buenos Aires.
          </p>
        </div>
        <div className="pie-col">
          <span className="pie-tit">CÓMO LEER ESTE SITIO</span>
          <Link href="/metodologia">Metodología y cobertura</Link>
          <Link href="/senales">Qué es una señal (y qué no)</Link>
          <Link href="/metodologia#confianza">Niveles de confianza</Link>
        </div>
        <div className="pie-col">
          <span className="pie-tit">CORRECCIONES</span>
          <Link href="/metodologia#correcciones">Reportar un error en un dato</Link>
          <Link href="/metodologia#replica">Derecho a réplica para empresas y organismos</Link>
          <Link href="/metodologia#cambios">Registro de cambios</Link>
        </div>
        <div className="pie-col">
          <span className="pie-tit">FUENTES</span>
          <a href="https://boletinoficial.buenosaires.gob.ar" rel="noopener noreferrer">
            Boletín Oficial CABA <span aria-hidden="true">↗</span>
          </a>
          <a href="https://www.buenosairescompras.gob.ar" rel="noopener noreferrer">
            Buenos Aires Compras <span aria-hidden="true">↗</span>
          </a>
          <span>
            Contacto: <em className="ph">[mail del equipo, a definir]</em>
          </span>
        </div>
      </div>
      <div className="pie-base">
        <span>
          Datos: {mesAnio(cob.primera)} – {mesAnio(cob.ultima)} · última corrida de ingesta{" "}
          {cob.ultima_ingesta ? fecha(cob.ultima_ingesta) : <em className="ph">[sin registro]</em>}
        </span>
        <span>
          Licencia de los datos: <em className="ph">[a definir]</em>
        </span>
      </div>
    </footer>
  );
}

export default function Marco({ activo, children, angosto = false, ficha = false }: { activo: Seccion; children: ReactNode; angosto?: boolean; ficha?: boolean }) {
  return (
    <>
      <Encabezado activo={activo} />
      <main id="contenido" className={`main${angosto ? " angosto" : ""}${ficha ? " ficha" : ""}`} tabIndex={-1}>
        {children}
      </main>
      <Pie />
    </>
  );
}
