# The engine image: what a Cloud Run job runs (scripts/deploy-gcp.sh builds and deploys it).
# The default command is one ingest run (src/ingestCli.ts), which exits 1 when the run failed so
# Cloud Run records the execution as failed. The agent job and the verify job run this same image with their
# arguments replaced (scripts/deploy-gcp.sh, DEPLOY_AGENT=1). The web UI is not in this image: it deploys to Hosting.
#
# Node is pinned to the patch CI runs: 24.17.0 broke google-auth-library's STS exchange.
FROM node:24.16.0-slim

ENV NODE_ENV=production
# git: the agent checks out the target repository and the verify gate applies a patch with `git apply`. tar and
# chown (already here) carry the verify bundle and hand the scratch copy to an unprivileged user.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable pnpm
WORKDIR /app

# Dependencies first, so a source-only change reuses the cached layer. web/package.json is only
# here because the lockfile has a web importer; --filter keeps web's dependencies out of the image.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --prod --filter starfish

COPY tsconfig.json ./
COPY src ./src

# Not root, with one exception the entrypoint makes explicit: it drops to `node` for everything except the verify
# runner. The runtime identity is the service account Cloud Run attaches, not anything baked in.
COPY docker-entrypoint.sh /usr/local/bin/starfish-entrypoint
RUN chmod 0755 /usr/local/bin/starfish-entrypoint
ENTRYPOINT ["/usr/local/bin/starfish-entrypoint"]

# tsx is a runtime dependency: the engine is TypeScript run directly, as `pnpm ingest` does.
CMD ["node", "--import", "tsx", "src/ingestCli.ts"]
