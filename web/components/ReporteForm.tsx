"use client";

import { useActionState, useId } from "react";
import { enviarReporte, type Estado } from "@/lib/acciones";
import { Turnstile } from "./Turnstile";

type Props = {
  tipo: "error" | "cuit";
  entidad: "proceso" | "proveedor" | "organismo" | "firma";
  clave: string;
  pagina: string;
  etiqueta: string;
  nombreFirma?: string;
  campos?: string[];
  siteKey: string | null;
  claseBoton?: string;
  comoEnlace?: boolean;
};

/** "Reportar un error en este dato" y "Sugerir CUIT": un desplegable con el formulario. */
export function ReporteForm({ tipo, entidad, clave, pagina, etiqueta, nombreFirma, campos, siteKey, claseBoton = "btn sec", comoEnlace = false }: Props) {
  const [estado, accion, enviando] = useActionState<Estado, FormData>(enviarReporte, null);
  const id = useId();
  return (
    <details className="disclosure">
      <summary className={comoEnlace ? undefined : claseBoton} style={comoEnlace ? { color: "var(--celdeep)", textDecoration: "underline", display: "inline", minHeight: 44 } : { background: "#fff" }}>
        {etiqueta}
      </summary>
      {estado?.ok ? (
        <p className="ok" role="status">
          {estado.mensaje}
        </p>
      ) : (
        <form action={accion} className="form-panel">
          <input type="hidden" name="tipo" value={tipo} />
          <input type="hidden" name="entidad" value={entidad} />
          <input type="hidden" name="clave" value={clave} />
          <input type="hidden" name="pagina" value={pagina} />
          <div className="trampa" aria-hidden="true">
            <label>
              No completar
              <input type="text" name="sitio_web" tabIndex={-1} autoComplete="off" />
            </label>
          </div>
          {tipo === "cuit" ? (
            <>
              <p className="p14">
                ¿Sabés cuál es el CUIT de <strong>{nombreFirma}</strong>? Lo revisamos antes de vincularlo.
              </p>
              <label className="field" htmlFor={`${id}-cuit`}>
                CUIT
                <input id={`${id}-cuit`} name="cuit" inputMode="numeric" placeholder="30-12345678-9" required autoComplete="off" />
              </label>
              <label className="field" htmlFor={`${id}-msj`}>
                ¿De dónde sale? (opcional)
                <textarea id={`${id}-msj`} name="mensaje" maxLength={2000} />
              </label>
            </>
          ) : (
            <>
              {campos?.length ? (
                <label className="field" htmlFor={`${id}-campo`}>
                  Dato
                  <select id={`${id}-campo`} name="campo" defaultValue="">
                    <option value="">Otro / no sé</option>
                    {campos.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="field" htmlFor={`${id}-msj`}>
                Qué está mal y, si podés, el documento que lo respalda
                <textarea id={`${id}-msj`} name="mensaje" required minLength={5} maxLength={4000} />
              </label>
            </>
          )}
          <label className="field" htmlFor={`${id}-mail`}>
            Tu mail (opcional, para responderte)
            <input id={`${id}-mail`} name="email" type="email" autoComplete="email" />
          </label>
          <Turnstile siteKey={siteKey} />
          {estado && !estado.ok ? (
            <p className="error" role="alert">
              {estado.mensaje}
            </p>
          ) : null}
          <button type="submit" className="btn" disabled={enviando} style={{ alignSelf: "flex-start" }}>
            {enviando ? "Enviando…" : "Enviar"}
          </button>
        </form>
      )}
    </details>
  );
}
