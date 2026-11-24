import "server-only";

/** Turnstile activo solo si TURNSTILE_ENABLED=true y hay clave de sitio (en desarrollo local se apaga). */
export function turnstileActivo(): boolean {
  return process.env.TURNSTILE_ENABLED === "true" && Boolean(process.env.TURNSTILE_SITE_KEY);
}

export function turnstileSiteKey(): string | null {
  return turnstileActivo() ? (process.env.TURNSTILE_SITE_KEY ?? null) : null;
}

/** Verifica el token del widget contra Cloudflare. Sin Turnstile activo, siempre pasa. */
export async function verificarTurnstile(token: string | null, ip: string | null): Promise<boolean> {
  if (!turnstileActivo()) return true;
  const secreto = process.env.TURNSTILE_SECRET_KEY;
  if (!secreto || !token) return false;
  const cuerpo = new FormData();
  cuerpo.append("secret", secreto);
  cuerpo.append("response", token);
  if (ip) cuerpo.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: cuerpo });
    const j = (await r.json()) as { success?: boolean };
    return j.success === true;
  } catch {
    return false;
  }
}
