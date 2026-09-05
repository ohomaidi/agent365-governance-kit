# Agent 365 Governance Proxy — container image.
# Runs the reverse proxy + Teams bridge; configuration comes entirely from the
# environment (the same keys the installer writes to .env). Built and pushed by
# .github/workflows/proxy-image.yml to ghcr.io/ohomaidi/agent365-governance-proxy.
#
# Stage 1 builds the kit inside the repo's npm workspace (the compiler is a
# workspace dev dependency) and packs it; stage 2 installs the proxy with that
# tarball, production-only, so the image carries no build tooling.
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/typescript ./packages/typescript
COPY packages/proxy ./packages/proxy
RUN node -v && npm -v \
 && npm ci --no-audit --no-fund \
 && node node_modules/typescript/bin/tsc -v \
 && (cd packages/typescript && node ../../node_modules/typescript/bin/tsc -p tsconfig.json --listEmittedFiles | tail -n 3) \
 && npm pack --silent --workspace @zaatarlabs/agent365-governance-kit --pack-destination /out >/dev/null

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY packages/proxy/package.json ./
COPY packages/proxy/src ./src
COPY --from=build /out/zaatarlabs-agent365-governance-kit-*.tgz /tmp/kit.tgz
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock /tmp/kit.tgz \
 && rm -f /tmp/kit.tgz
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.GOVERNANCE_PROXY_PORT||8787)+'/_governance/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/bin.mjs"]
