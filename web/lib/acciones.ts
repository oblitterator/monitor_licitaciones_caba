"use server";

import { headers } from "next/headers";
import { escribir } from "./db";
import { cuitValido, parsearCuit } from "./formato";
import { verificarTurnstile } from "./turnstile";
import { enviarConfirmacion } from "./correo";
import { urlSitio } from "./sitio";

export type Estado = { ok: boolean; mensaje: string } | null;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const txt = (fd: FormData, k: string, max: number) => String(fd.get(k) ?? "").trim().slice(0, max);

async function controles(fd: FormData): Promise<string | null> {
  // trampa para bots: un campo invisible que una persona no completa
  if (txt(fd, "sitio_web", 200)) return "No pudimos procesar el envío.";
  const h = await headers();
  const ip = h.get("cf-connecting-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ok = await verificarTurnstile(String(fd.get("cf-turnstile-response") ?? "") || null, ip);
  return ok ? null : "No pudimos verificar que no seas un robot. Probá de nuevo.";
}

const ENTIDADES = new Set(["proceso", "proveedor", "organismo", "firma"]);

/** "Reportar un error" y "Sugerir CUIT": van a app.reporte para revisión manual. */
export async function enviarReporte(_prev: Estado, fd: FormData): Promise<Estado> {
  const tipo = txt(fd, "tipo", 10) === "cuit" ? "cuit" : "error";
  const entidad = txt(fd, "entidad", 20);
  const clave = txt(fd, "clave", 200);
  const campo = txt(fd, "campo", 100) || null;
  const mensaje = txt(fd, "mensaje", 4000) || null;
  const email = txt(fd, "email", 254) || null;
  const pagina = txt(fd, "pagina", 500) || null;
  if (!ENTIDADES.has(entidad) || !clave) return { ok: false, mensaje: "Faltan datos del registro a corregir." };
  if (email && !EMAIL.test(email)) return { ok: false, mensaje: "El mail no parece válido." };
  let cuit: string | null = null;
  if (tipo === "cuit") {
    cuit = parsearCuit(txt(fd, "cuit", 20));
    if (!cuit || !cuitValido(cuit)) return { ok: false, mensaje: "El CUIT no es válido: revisá los 11 dígitos." };
  } else if (!mensaje || mensaje.length < 5) {
    return { ok: false, mensaje: "Contanos qué está mal (al menos unas palabras)." };
  }
  const err = await controles(fd);
  if (err) return { ok: false, mensaje: err };
  try {
    await escribir(
      `INSERT INTO app.reporte (tipo, entidad, clave, campo, mensaje, cuit_sugerido, email, pagina)
       VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, $8)`,
      [tipo, entidad, clave, campo, mensaje, cuit, email, pagina],
    );
  } catch {
    return { ok: false, mensaje: "No pudimos guardar el reporte. Probá de nuevo en un rato." };
  }
  return {
    ok: true,
    mensaje: tipo === "cuit" ? "Gracias. Vamos a revisar el CUIT sugerido antes de vincularlo." : "Gracias. Lo revisamos y, si corresponde, lo corregimos y lo anotamos en el registro de cambios.",
  };
}

const TIPOS_ALERTA = new Set(["palabra", "organismo", "proveedor", "senal"]);

function token(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Alta de alerta con doble opt-in (queda sin confirmar hasta abrir el enlace del mail). */
export async function crearAlerta(_prev: Estado, fd: FormData): Promise<Estado> {
  const tipo = txt(fd, "tipo", 20);
  const valor = txt(fd, "valor", 200);
  const email = txt(fd, "email", 254).toLowerCase();
  if (!TIPOS_ALERTA.has(tipo)) return { ok: false, mensaje: "Elegí qué querés seguir." };
  if (!valor) return { ok: false, mensaje: "Completá qué querés seguir." };
  if (!EMAIL.test(email)) return { ok: false, mensaje: "Revisá el mail: no parece válido." };
  if (tipo === "proveedor" && /^[\d\s.-]+$/.test(valor) && !cuitValido(valor)) return { ok: false, mensaje: "El CUIT no es válido." };
  const err = await controles(fd);
  if (err) return { ok: false, mensaje: err };
  try {
    const filas = await escribir<{ token_confirmacion: string; confirmada_en: string | null }>(
      `INSERT INTO app.alerta (email, tipo, valor, token_confirmacion, token_baja)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (lower(email), tipo, lower(valor)) DO UPDATE SET actualizada_en = now(), baja_en = NULL
       RETURNING token_confirmacion, confirmada_en`,
      [email, tipo, valor, token(), token()],
    );
    const f = filas[0];
    if (f && !f.confirmada_en) {
      await enviarConfirmacion({ email, tipo, valor, urlConfirmar: `${urlSitio()}/alertas/confirmar?token=${f.token_confirmacion}` });
    }
  } catch {
    return { ok: false, mensaje: "No pudimos guardar la alerta. Probá de nuevo en un rato." };
  }
  return {
    ok: true,
    mensaje: "Listo. Te vamos a mandar un mail para confirmar la dirección; hasta que no la confirmes no te enviamos nada. (Piloto: el envío de mails todavía no está activo.)",
  };
}
