import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Public_Sans, Source_Serif_4 } from "next/font/google";
import "./globals.css";
import { NOMBRE_SITIO, urlSitio } from "@/lib/sitio";

const serif = Source_Serif_4({ subsets: ["latin"], weight: ["400", "600", "700"], variable: "--font-serif", display: "swap" });
const sans = Public_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-sans", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(urlSitio()),
  title: { default: `${NOMBRE_SITIO}`, template: `%s · ${NOMBRE_SITIO}` },
  description:
    "Las compras y contrataciones de la Ciudad de Buenos Aires publicadas en el Boletín Oficial: procesos, proveedores, organismos y señales para priorizar la revisión, cada dato con su documento.",
  openGraph: { siteName: NOMBRE_SITIO, locale: "es_AR", type: "website" },
  twitter: { card: "summary" },
  alternates: { canonical: "/" },
};

// Todas las páginas leen la base en el momento del pedido (no en el build); las
// lecturas se cachean 1 h con unstable_cache (lib/datos.ts).
export const dynamic = "force-dynamic";

export const viewport: Viewport = { themeColor: "#0F1D2E", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-AR" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
