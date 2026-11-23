import "server-only";
import postgres from "postgres";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Único punto de acceso a Postgres.
 *
 * - En Cloudflare Workers usa el binding de Hyperdrive (env.HYPERDRIVE). Un
 *   Worker no puede compartir conexiones entre pedidos, así que se abre un
 *   cliente por consulta y se cierra al terminar; Hyperdrive mantiene el pool.
 * - En Node (`next dev`, `next start`) usa DATABASE_URL con un pool global.
 *
 * Fechas y numéricos vuelven como texto (JSON serializable para la caché de
 * datos de Next); los formateadores de lib/formato.ts los convierten.
 */

type Sql = postgres.Sql<Record<string, never>>;
export type Fila = Record<string, unknown>;

const comoTexto = (oid: number) => ({ to: oid, from: [oid], serialize: (x: unknown) => String(x), parse: (x: string) => x });

const opciones = {
  // date, timestamp, timestamptz como texto ISO
  types: { fecha: comoTexto(1082), ts: comoTexto(1114), tstz: comoTexto(1184) },
  fetch_types: false,
  prepare: true,
  connection: { application_name: "monitor-web" },
} as const;

let pool: Sql | undefined;

type Contexto = { env: CloudflareEnv; ctx: { waitUntil(p: Promise<unknown>): void } };

function contextoCf(): Contexto | undefined {
  try {
    const c = getCloudflareContext() as unknown as Contexto;
    return c.env?.HYPERDRIVE?.connectionString ? c : undefined;
  } catch {
    return undefined;
  }
}

/**
 * En Workers: un cliente por consulta (las consultas de un render corren en
 * paralelo y Hyperdrive ya mantiene el pool del lado de Cloudflare). El cierre
 * se deja a waitUntil, después de que la consulta terminó.
 */
async function conCliente<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  const c = contextoCf();
  if (c) {
    const sql = postgres(c.env.HYPERDRIVE!.connectionString, { ...opciones, max: 1 }) as unknown as Sql;
    try {
      return await fn(sql);
    } finally {
      c.ctx.waitUntil(sql.end({ timeout: 5 }).catch(() => undefined));
    }
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Falta DATABASE_URL (o el binding HYPERDRIVE en Cloudflare)");
  pool ??= postgres(url, { ...opciones, max: 8, idle_timeout: 30 }) as unknown as Sql;
  return fn(pool);
}

/** Consulta de solo lectura con parámetros posicionales ($1, $2, ...). */
export async function consultar<T extends Fila = Fila>(texto: string, params: readonly unknown[] = []): Promise<T[]> {
  return conCliente(async (sql) => {
    const filas = await sql.begin("read only", (tx) => tx.unsafe(texto, params as never[]));
    return filas as unknown as T[];
  });
}

export async function consultarUna<T extends Fila = Fila>(texto: string, params: readonly unknown[] = []): Promise<T | undefined> {
  const filas = await consultar<T>(texto, params);
  return filas[0];
}

/** Escritura (solo para las tablas del esquema app). */
export async function escribir<T extends Fila = Fila>(texto: string, params: readonly unknown[] = []): Promise<T[]> {
  if (!/^\s*(insert into|update)\s+app\./i.test(texto)) throw new Error("Solo se escribe en el esquema app");
  return conCliente(async (sql) => (await sql.unsafe(texto, params as never[])) as unknown as T[]);
}
