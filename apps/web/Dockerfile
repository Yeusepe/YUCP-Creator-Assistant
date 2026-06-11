# syntax=docker/dockerfile:1.7
FROM oven/bun:1.3.10

WORKDIR /src

COPY . .

RUN --mount=type=secret,id=HEROUI_AUTH_TOKEN,required=true \
    HEROUI_AUTH_TOKEN="$(cat /run/secrets/HEROUI_AUTH_TOKEN)" bun install --frozen-lockfile

# This image is only a Bun-hosted compatibility preview for environments that
# still need a local/container smoke path. Cloudflare Workers is the production
# hosting path for apps/web.

WORKDIR /src/apps/web

RUN bun run build
RUN addgroup --system --gid 1001 appgroup \
    && adduser --system --uid 1001 --ingroup appgroup appuser \
    && chown -R appuser:appgroup /src/apps/web

ENV NODE_ENV=production
ENV LOG_LEVEL=debug
# Zeabur injects PORT at runtime, usually 8080.
# vite preview reads process.env.PORT through apps/web/vite.config.ts.
EXPOSE 8080

USER appuser

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["/bin/sh", "-lc", "bun -e \"fetch('http://127.0.0.1:${PORT:-8080}').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))\""]

CMD ["/bin/sh", "-lc", "echo \"[web] bun=$(bun --version) node_env=${NODE_ENV} port=${PORT:-unset}\" && bun run start"]
