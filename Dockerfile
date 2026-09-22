# syntax=docker/dockerfile:1

# Build stage: full toolchain (typescript, tsx, esbuild devDeps -- npm run build needs them).
FROM node:22-bookworm-slim AS build
WORKDIR /app
# The whole source tree has to be present before `npm ci`, not after: package.json's own
# `prepare` script (`npm run build`) fires as part of `ci`, and it needs real source to build --
# found live, `npm ci` failing on a missing src/cli/core/generate-cli.ts because only
# package*.json existed at that point. Costs the layer-caching a bare package.json copy would
# have bought; correctness first.
COPY . .
RUN npm ci
# Dev deps (typescript, tsx, esbuild's CLI, vitest, ...) were needed to produce dist/ and
# dist/parts/*.cjs above; nothing at runtime imports them, so they don't belong in the image.
RUN npm prune --omit=dev

# Runtime stage. Not alpine/distroless: mesh-serve's own catalog build pipeline
# (src/catalog/methods/build.ts) shells out to real `git`/`npm` *from inside the running process*
# to build a service part on demand (serve.artifact.requestBuild) -- the container needs those
# binaries and a real shell to exec them from, not just node.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The base image already ships a `node` user at uid/gid 1000 -- which happens to be the real
# `ubuntu` user's own uid/gid on every one of these VPS boxes, confirmed directly (`id ubuntu`).
# Reusing it, rather than creating a second uid-1000 identity, is what makes a bind-mounted
# ~/.mesh (build cache, git checkouts) come out owned by the container user on every host without
# a UID mapping to get wrong.
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/bin ./bin
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules

USER node
ENV HOME=/home/node
ENTRYPOINT ["node", "/app/bin/mesh-serve.mjs"]
CMD ["--help"]
