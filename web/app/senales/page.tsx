import type { Metadata } from "next";
import Marco from "@/components/Marco";
import VistaSenales from "@/components/VistaSenales";
import { SENALES } from "@/lib/catalogo";

export const metadata: Metadata = {
  title: "Señales",
  description: "Oferta única, concentración, procedimientos de excepción, posible fraccionamiento, empresas nuevas, domicilios compartidos y modificaciones: indicadores para priorizar la revisión de las compras de la Ciudad.",
  alternates: { canonical: "/senales" },
};

export default function Senales() {
  return (
    <Marco activo="senales">
      <VistaSenales sel={SENALES[0]!} f={{ org: null, anio: null, orden: "fecha", pagina: 1 }} />
    </Marco>
  );
}
