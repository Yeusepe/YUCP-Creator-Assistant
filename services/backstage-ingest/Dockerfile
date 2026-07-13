FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

# BACKSTAGE_INGEST_REDIS_URL is required at runtime and must identify a reachable Redis service.

WORKDIR /app

# --frozen-lockfile validates the committed lockfile against the manifests present, so every
# workspace manifest must be copied or bun reports a spurious lockfile change. --filter then scopes
# the actual install to the sidecar's subgraph (it + @yucp/shared), so no other workspace's deps —
# notably apps/web's private, auth-gated heroui packages — are downloaded into this image.
# ponytail: adding a workspace package means adding its manifest here; the frozen install fails loudly otherwise.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/bot/package.json apps/bot/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/policy/package.json packages/policy/package.json
COPY packages/private-rpc/package.json packages/private-rpc/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY services/backstage-ingest/package.json services/backstage-ingest/package.json
RUN bun install --production --frozen-lockfile --filter='@yucp/backstage-ingest'

COPY packages/shared/src packages/shared/src
COPY services/backstage-ingest/src services/backstage-ingest/src

RUN groupadd --system backstage-ingest \
  && useradd --system --gid backstage-ingest --home-dir /nonexistent --shell /usr/sbin/nologin backstage-ingest \
  && mkdir -p /data/tus \
  && chown -R backstage-ingest:backstage-ingest /data/tus /app/services/backstage-ingest

WORKDIR /app/services/backstage-ingest

VOLUME ["/data/tus"]
EXPOSE 8080

USER backstage-ingest:backstage-ingest

CMD ["bun", "run", "src/index.ts"]
