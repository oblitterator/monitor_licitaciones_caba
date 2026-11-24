"use client";

import { useActionState, useState } from "react";
import { crearAlerta, type Estado } from "@/lib/acciones";
import { Turnstile } from "./Turnstile";

const TIPOS = [
  { id: "palabra", label: "Palabra clave", ej: "ej. “limpieza”", campo: "Palabra o frase", ph: "limpieza hospitalaria" },
  { id: "organismo", label: "Organismo", ej: "ej. un hospital", campo: "Organismo o número de UOA", ph: "Hospital Argerich" },
  { id: "proveedor", label: "Proveedor", ej: "por CUIT", campo: "CUIT o razón social", ph: "30-12345678-9" },
  { id: "senal", label: "Tipo de señal", ej: "ej. oferta única", campo: "Tipo de señal", ph: "Oferta única" },
] as const;

export function AlertaForm({ siteKey, tipoInicial, valorInicial }: { siteKey: string | null; tipoInicial?: string; valorInicial?: string }) {
  const [estado, accion, enviando] = useActionState<Estado, FormData>(crearAlerta, null);
  const [tipo, setTipo] = useState<string>(TIPOS.some((t) => t.id === tipoInicial) ? tipoInicial! : "palabra");
  const cur = TIPOS.find((t) => t.id === tipo) ?? TIPOS[0];
  if (estado?.ok) {
    return (
      <div className="ok" role="status">
        <strong>Alerta registrada.</strong> {estado.mensaje}
      </div>
    );
  }
  return (
    <form action={accion} className="col g20">
      <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="col g10">
        <legend className="field" style={{ marginBottom: 8, fontSize: 14 }}>
          ¿Qué querés seguir?
        </legend>
        <div className="opciones-alerta">
          {TIPOS.map((t) => (
            <label key={t.id} className="opcion">
              <input type="radio" name="tipo" value={t.id} checked={tipo === t.id} onChange={() => setTipo(t.id)} />
              <span style={{ fontWeight: 700, fontSize: 15 }}>{t.label}</span>
              <span className="opcion-sub">{t.ej}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field" style={{ fontSize: 14 }}>
        {cur.campo}
        {tipo === "senal" ? (
          <select name="valor" defaultValue="oferta-unica" style={{ minHeight: 48, fontSize: 16 }}>
            <option value="oferta-unica">Oferta única</option>
            <option value="modificaciones">Modificaciones</option>
            <option value="empresa-nueva">Empresa nueva</option>
            <option value="domicilio-compartido">Domicilio compartido</option>
            <option value="fraccionamiento">Posible fraccionamiento</option>
          </select>
        ) : (
          <input name="valor" type="text" required maxLength={200} placeholder={cur.ph} defaultValue={tipo === tipoInicial ? valorInicial : undefined} style={{ minHeight: 48, fontSize: 16 }} />
        )}
      </label>
      <label className="field" style={{ fontSize: 14 }}>
        Tu mail
        <input name="email" type="email" required autoComplete="email" placeholder="nombre@ejemplo.com" style={{ minHeight: 48, fontSize: 16 }} />
      </label>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="col g6">
        <legend className="field" style={{ marginBottom: 6, fontSize: 14 }}>
          Cómo recibirlo
        </legend>
        <label className="chk">
          <input type="radio" name="canal" value="mail" defaultChecked />
          Resumen diario por mail, a las 8 h
        </label>
      </fieldset>
      <div className="trampa" aria-hidden="true">
        <label>
          No completar
          <input type="text" name="sitio_web" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <Turnstile siteKey={siteKey} />
      {estado && !estado.ok ? (
        <p className="error m0" role="alert">
          {estado.mensaje}
        </p>
      ) : null}
      <div className="fila" style={{ gap: 12 }}>
        <button type="submit" className="btn" style={{ minHeight: 48, padding: "0 22px" }} disabled={enviando}>
          {enviando ? "Creando…" : "Crear alerta"}
        </button>
        <span className="note">Te vamos a pedir que confirmes el mail. Te podés dar de baja desde cualquier envío.</span>
      </div>
    </form>
  );
}
