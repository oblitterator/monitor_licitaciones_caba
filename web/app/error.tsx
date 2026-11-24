"use client";

import Link from "next/link";

export default function ErrorPagina({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="main angosto">
      <section className="box estado">
        <span className="kicker">Error al cargar</span>
        <h1 className="h3">No pudimos traer estos datos</h1>
        <p className="p14">Puede ser un problema momentáneo con la base. Probá de nuevo; si sigue fallando, avisanos.</p>
        <div className="fila">
          <button type="button" className="btn" onClick={() => reset()}>
            Reintentar
          </button>
          <Link className="btn sec" href="/metodologia#correcciones">
            Avisar al equipo
          </Link>
        </div>
      </section>
    </div>
  );
}
