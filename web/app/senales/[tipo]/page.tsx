import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Marco from "@/components/Marco";
import VistaSenales from "@/components/VistaSenales";
import { senalMeta } from "@/lib/catalogo";
import type { Params } from "@/lib/busqueda";

type P = { params: Promise<{ tipo: string }>; searchParams: Promise<Params> };
const uno = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const s = senalMeta((await params).tipo);
  if (!s) return { title: "Señal no encontrada", robots: { index: false } };
  return { title: `Señal: ${s.nombre}`, description: `${s.mide} ${s.calc}`, alternates: { canonical: `/senales/${s.id}` } };
}

export default async function SenalTipo({ params, searchParams }: P) {
  const s = senalMeta((await params).tipo);
  if (!s) notFound();
  const sp = await searchParams;
  const anio = Number.parseInt(uno(sp.anio), 10);
  return (
    <Marco activo="senales">
      <VistaSenales
        sel={s}
        f={{
          org: uno(sp.org) || null,
          anio: Number.isFinite(anio) ? anio : null,
          orden: uno(sp.orden) === "monto" ? "monto" : "fecha",
          pagina: Math.max(1, Number.parseInt(uno(sp.pagina), 10) || 1),
        }}
      />
    </Marco>
  );
}
