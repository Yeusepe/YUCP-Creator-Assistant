FROM oven/bun:1.3.10

WORKDIR /src

COPY . .

RUN bun install --frozen-lockfile

# CONVEX_URL is a public URL (not a secret) that gets baked into the client
# bundle at build time via Vite's `define`. Set this as a build ARG in Zeabur.
# It is also used by the built SSR server at runtime, so it is promoted to ENV too.
#
# Required build-time args in Zeabur:
# CONVEX_URL  (e.g. https://<your-project>.convex.cloud)
ARG CONVEX_URL
ENV CONVEX_URL=$CONVEX_URL

WORKDIR /src/apps/web

RUN bun run build

ENV NODE_ENV=production
ENV LOG_LEVEL=debug
ENV INFISICAL_ENV=prod

# Zeabur injects PORT at runtime, usually 8080.
# serve.ts reads process.env.PORT when starting the built SSR server.
EXPOSE 8080

CMD ["/bin/sh", "-lc", "echo \"[web] bun=$(bun --version) node_env=${NODE_ENV} infisical_env=${INFISICAL_ENV:-unset} port=${PORT:-unset} convex_url=${CONVEX_URL:+set}\" && bun run start"]
