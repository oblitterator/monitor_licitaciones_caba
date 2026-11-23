# Sitio web (Next.js) como servidor Node "standalone".
# Contexto de build: web/ (ver docker-compose.yml). Lo que no entra al build
# está en Dockerfile.dockerignore, al lado de este archivo.

# --- dependencias ---
FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN npm install -g pnpm@12.18.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# --- build ---
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
# NEXT_OUTPUT=standalone arma .next/standalone (ver next.config.ts)
RUN pnpm build:node

# --- imagen final: solo el server y los estáticos ---
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# El usuario "node" ya viene en la imagen oficial: no corremos como root
USER node
EXPOSE 3000
# /salud responde 200 si el server anda y llega a Postgres
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
