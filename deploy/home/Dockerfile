# Home backend image: the SQL gateway + the scheduled ingestion (one image, two
# compose services — see compose.yaml). Build context is the REPO ROOT:
#   docker compose -f deploy/home/compose.yaml build
FROM node:24-bookworm-slim

# sqlite3: one-time import of the D1 export + ad-hoc inspection.
# tzdata:  supercronic schedules in TZ (Pacific/Honolulu, set in compose.yaml).
RUN apt-get update \
 && apt-get install -y --no-install-recommends sqlite3 tzdata ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# supercronic: cron for containers (passes env through, logs to stdout, never
# overlaps a still-running job). Pinned by version + sha256 (GitHub asset digests).
ARG TARGETARCH
ARG SUPERCRONIC_VERSION=v0.2.51
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) sha=cc232108374e8e2b537045f2d5eaa1229f619db314c3ba6a14d38b35dc0aa123 ;; \
      arm64) sha=4ae22576a78223d8ccdf5f3b3660a5cbb5288416bf0ca96afc4a36d195932b94 ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${TARGETARCH:-amd64}"; \
    echo "${sha}  /usr/local/bin/supercronic" | sha256sum -c -; \
    chmod +x /usr/local/bin/supercronic

RUN corepack enable && mkdir /app && chown node:node /app

# Install AND run as `node`: Yarn's global cache and corepack's Yarn download
# land in /home/node, readable at runtime (installing as root would strand them
# in /root, where the non-root process can't resolve PnP packages).
USER node
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
# Dependency layer first (cached until the lockfile or manifests change).
COPY --chown=node:node package.json yarn.lock .yarnrc.yml ./
COPY --chown=node:node .yarn/sdks ./.yarn/sdks
COPY --chown=node:node web/package.json ./web/package.json
RUN yarn install --immutable

COPY --chown=node:node . .
WORKDIR /app/web

ENV NODE_ENV=production
EXPOSE 8787
CMD ["yarn", "gateway"]
