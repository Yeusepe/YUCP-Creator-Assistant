FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

WORKDIR /app

COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/package.json
COPY services/backstage-ingest/package.json services/backstage-ingest/package.json
RUN bun install --production --frozen-lockfile

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
