import Link from "next/link";
import Marco from "@/components/Marco";

export default function NoEncontrado() {
  return (
    <Marco activo={null} angosto>
      <section className="box estado">
        <span className="kicker">No encontrado</span>
        <h1 className="h2">No tenemos esa página</h1>
        <p className="p14">Puede que el código de proceso, el CUIT o el organismo no estén en la base, o que el enlace esté mal escrito.</p>
        <ul className="p14" style={{ paddingLeft: 18, lineHeight: 1.6 }}>
          <li>
            Buscalo en el <Link href="/procesos">buscador de procesos</Link>
          </li>
          <li>
            Revisá la <Link href="/metodologia#cobertura">cobertura de la base</Link>: puede ser de un período todavía no cargado
          </li>
        </ul>
      </section>
    </Marco>
  );
}
