// Tipos de los bindings de wrangler.jsonc. Se pueden regenerar con `pnpm cf-typegen`.
interface CloudflareEnv {
  ASSETS: Fetcher;
  HYPERDRIVE?: { connectionString: string };
  NEXT_INC_CACHE_R2_BUCKET?: unknown;
  WORKER_SELF_REFERENCE?: Fetcher;
  TURNSTILE_ENABLED?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  SITE_URL?: string;
  DATABASE_URL?: string;
}
