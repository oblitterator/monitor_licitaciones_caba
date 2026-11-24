import type { MetadataRoute } from "next";
import { obtenerClavesSitemap } from "@/lib/datos";
import { SENALES } from "@/lib/catalogo";
import { rutaOrganismo, rutaProceso, rutaProveedor, urlSitio } from "@/lib/sitio";

export const dynamic = "force-dynamic";
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const u = urlSitio();
  const { procesos, proveedores, organismos } = await obtenerClavesSitemap();
  const fijas = ["/", "/procesos", "/proveedores", "/organismos", "/senales", "/alertas", "/metodologia", ...SENALES.map((s) => `/senales/${s.id}`)];
  return [
    ...fijas.map((p) => ({ url: u + p, changeFrequency: "daily" as const, priority: p === "/" ? 1 : 0.6 })),
    ...procesos.map((p) => ({ url: u + rutaProceso(p.k), lastModified: p.f ?? undefined, changeFrequency: "weekly" as const, priority: 0.5 })),
    ...proveedores.map((p) => ({ url: u + rutaProveedor(p.k), lastModified: p.f ?? undefined, changeFrequency: "weekly" as const, priority: 0.4 })),
    ...organismos.map((o) => ({ url: u + rutaOrganismo(o.k), changeFrequency: "weekly" as const, priority: 0.4 })),
  ];
}
