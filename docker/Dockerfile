# Build the bundled server + web client, then ship a tiny runtime image.
#
# Dependencies first, from the lockfile alone (REV-08): `pnpm fetch` fills the
# store from pnpm-lock.yaml, so an edit to the source reuses this stage and a
# change to the lockfile (or the pnpm version or settings) redoes it.
FROM node:24-alpine AS deps
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

FROM deps AS build
COPY . .
# Only what the image ships: the server and the packages it bundles, the web
# client among them; nothing of the desktop app or the test tooling.
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --offline --frozen-lockfile --filter "ownbase-server..."
# The image has no .git to ask which source it is (IMP-08); CI passes the
# commit. Declared after installing, so a new commit reuses that step.
ARG GITHUB_SHA=unknown
ENV GITHUB_SHA=${GITHUB_SHA}
RUN pnpm --filter @ownbase/web build && pnpm --filter ownbase-server build

FROM node:24-alpine
RUN addgroup -S ownbase && adduser -S ownbase -G ownbase
RUN mkdir -p /data /app && chown ownbase:ownbase /data /app
USER ownbase
WORKDIR /app
COPY --from=build /repo/apps/server-cli/dist ./
VOLUME /data
EXPOSE 8543
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8543/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# mDNS is pointless inside a container; hosts on a LAN should run the binary directly.
ENTRYPOINT ["node", "ownbase-server.js", "--data", "/data", "--no-mdns"]
