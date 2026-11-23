import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  typedRoutes: false,
  agentRules: false,
  // postgres.js usa módulos de Node: no lo empaquetamos en el build de Node
  serverExternalPackages: ["postgres"],
};

export default nextConfig;

// Permite usar getCloudflareContext() durante `next dev` (bindings de wrangler.jsonc)
if (process.env.NODE_ENV === "development" && process.env.CF_DEV === "1") {
  void import("@opennextjs/cloudflare").then((m) => m.initOpenNextCloudflareForDev());
}
