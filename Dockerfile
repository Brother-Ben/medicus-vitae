# Medicus Vitae container image (PLAT-02). Built for linux/amd64 and linux/arm64
# by .github/workflows/release.yml; also builds locally with `docker build .`.
# Settings keep their CORTEX_ names so existing .env files still work.
# better-sqlite3 and argon2 ship prebuilt Linux binaries inside their npm
# packages, so no compiler is needed (scripts/install-deps.mjs keeps npm from
# trying to compile better-sqlite3 anyway).

FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/install-deps.mjs ./scripts/
RUN node scripts/install-deps.mjs
COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.22.1-bookworm-slim
LABEL org.opencontainers.image.title="Medicus Vitae"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    CORTEX_DATA_DIR=/data \
    CORTEX_ALLOW_QUIT=false
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/server ./server
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/src/lib/pdf ./src/lib/pdf
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
