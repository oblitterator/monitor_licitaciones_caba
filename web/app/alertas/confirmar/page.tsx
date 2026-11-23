import type { Metadata } from "next";
import Link from "next/link";
import Marco from "@/components/Marco";
import { escribir } from "@/lib/db";
import type { Params } from "@/lib/busqueda";

export const metadata: Metadata = { title: "Confirmar alerta", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

// Doble opt-in: el enlace del mail de confirmación trae el token de un solo uso.
export default async function Confirmar({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const token = String(Array.isArray(sp.token) ? sp.token[0] : (sp.token ?? ""));
  let ok = false;
  if (/^[0-9a-f]{48}$/.test(token)) {
    const filas = await escribir(
      `UPDATE app.alerta SET confirmada_en = coalesce(confirmada_en, now()), actualizada_en = now()
       WHERE token_confirmacion = $1 AND baja_en IS NULL RETURNING id`,
      [token],
    );
    ok = filas.length > 0;
  }
  return (
    <Marco activo="alertas" angosto>
      <section className="box estado">
        <span className="kicker">Alertas</span>
        <h1 className="h2">{ok ? "Listo, confirmaste tu mail" : "El enlace no es válido"}</h1>
        <p className="p14">
          {ok ? "Desde el próximo boletín procesado vas a recibir el resumen." : "Puede que ya haya vencido o que la alerta se haya dado de baja. Podés crearla de nuevo."}
        </p>
        <Link href="/alertas">Volver a alertas →</Link>
      </section>
    </Marco>
  );
}
