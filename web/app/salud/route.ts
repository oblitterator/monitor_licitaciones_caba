import { consultarUna } from "@/lib/db";

// Chequeo de salud para Docker y monitoreo: responde 200 si el server está
// arriba y llega a Postgres; 503 si no hay base. No se cachea.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await consultarUna("SELECT 1 AS ok");
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
