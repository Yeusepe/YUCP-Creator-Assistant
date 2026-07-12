FROM oven/bun:1.3.14

WORKDIR /app

COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/package.json
COPY services/backstage-ingest/package.json services/backstage-ingest/package.json
RUN bun install --production --frozen-lockfile

COPY packages/shared/src packages/shared/src
COPY services/backstage-ingest/src services/backstage-ingest/src

WORKDIR /app/services/backstage-ingest

VOLUME ["/data/tus"]
EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]
