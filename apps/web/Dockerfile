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

RUN --mount=type=secret,id=ASSETS_S3_BUCKET,required=true \
    --mount=type=secret,id=ASSETS_S3_ENDPOINT,required=true \
    --mount=type=secret,id=ASSETS_S3_REGION,required=true \
    --mount=type=secret,id=ASSETS_S3_READONLY_ACCESS_KEY_ID,required=true \
    --mount=type=secret,id=ASSETS_S3_READONLY_SECRET_ACCESS_KEY,required=true \
    ASSETS_S3_BUCKET="$(cat /run/secrets/ASSETS_S3_BUCKET)" \
    ASSETS_S3_ENDPOINT="$(cat /run/secrets/ASSETS_S3_ENDPOINT)" \
    ASSETS_S3_REGION="$(cat /run/secrets/ASSETS_S3_REGION)" \
    ASSETS_S3_READONLY_ACCESS_KEY_ID="$(cat /run/secrets/ASSETS_S3_READONLY_ACCESS_KEY_ID)" \
    ASSETS_S3_READONLY_SECRET_ACCESS_KEY="$(cat /run/secrets/ASSETS_S3_READONLY_SECRET_ACCESS_KEY)" \
    bun run build

ENV NODE_ENV=production
ENV LOG_LEVEL=info
# Runtime hosts may inject PORT; Vite preview defaults to 3000 when it is unset.
# vite preview reads process.env.PORT through apps/web/vite.config.ts.
EXPOSE 3000

USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["/bin/sh", "-lc", "bun -e \"fetch('http://127.0.0.1:${PORT:-3000}').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))\""]

CMD ["/bin/sh", "-lc", "echo \"[web] bun=$(bun --version) node_env=${NODE_ENV} port=${PORT:-unset}\" && bun run start"]
