export const NOMBRE_SITIO = "Monitor de Licitaciones CABA";

/** URL pública del sitio (canonical, sitemap, Open Graph). */
export function urlSitio(): string {
  const u = process.env.SITE_URL || "http://localhost:3000";
  return u.replace(/\/+$/, "");
}

/** Codifica un código de proceso para la ruta /procesos/[...codigo] (los SIGAF llevan "/"). */
export function rutaProceso(codigo: string): string {
  return "/procesos/" + codigo.split("/").map(encodeURIComponent).join("/");
}

export function rutaOrganismo(id: string): string {
  return "/organismos/" + encodeURIComponent(id);
}

export function rutaProveedor(cuit: string | number): string {
  return "/proveedores/" + String(cuit);
}
