# Agent 365 Governance Proxy — container image.
# Runs the reverse proxy + Teams bridge; configuration comes entirely from the
# environment (the same keys the installer writes to .env). Built and pushed by
# .github/workflows/proxy-image.yml to ghcr.io/ohomaidi/agent365-governance-proxy.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# The kit package the proxy depends on, then the proxy itself.
COPY packages/typescript /src/typescript
COPY packages/proxy /src/proxy
# tsc is a dev dependency of the kit, so its build needs the full install; the
# proxy then installs the packed kit tarball production-only.
RUN cd /src/typescript && npm ci --no-audit --no-fund && npm run build \
 && npm pack --silent --pack-destination /src >/dev/null \
 && cd /src/proxy && rm -rf node_modules \
 && npm install --omit=dev --no-audit --no-fund /src/zaatarlabs-agent365-governance-kit-*.tgz \
 && cp -r /src/proxy/. /app/ && rm -rf /src
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${GOVERNANCE_PROXY_PORT:-8787}/_governance/health || exit 1
CMD ["node", "src/bin.mjs"]
