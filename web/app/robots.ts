import type { MetadataRoute } from "next";
import { urlSitio } from "@/lib/sitio";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/procesos/exportar", "/alertas/confirmar"] }],
    sitemap: `${urlSitio()}/sitemap.xml`,
  };
}
