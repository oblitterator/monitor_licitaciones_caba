"use client";

import Script from "next/script";

/** Widget de Cloudflare Turnstile. Solo se dibuja si el servidor pasó una clave de sitio. */
export function Turnstile({ siteKey }: { siteKey: string | null }) {
  if (!siteKey) return null;
  return (
    <>
      <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" strategy="afterInteractive" async defer />
      <div className="cf-turnstile" data-sitekey={siteKey} data-language="es" />
    </>
  );
}
