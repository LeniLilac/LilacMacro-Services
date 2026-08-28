FROM node:24.19.0-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY public ./public
COPY scripts ./scripts
COPY src ./src
COPY tsconfig.json tsconfig.build.json ./
RUN npm run build \
  && npm prune --omit=dev \
  && npm cache clean --force

FROM node:24.19.0-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime

WORKDIR /app
ENV HOME=/home/node \
  NODE_ENV=production \
  NPM_CONFIG_CACHE=/tmp/npm-cache

COPY --from=build --chmod=0444 /app/package.json /app/package-lock.json ./
COPY --from=build --chmod=0555 /app/node_modules ./node_modules
COPY --from=build --chmod=0555 /app/dist ./dist
COPY --from=build --chmod=0555 /app/scripts/check-heartbeat.mjs ./scripts/check-heartbeat.mjs
COPY --chmod=0555 migrations ./migrations

RUN find /app/migrations -type f -exec chmod 0444 {} + \
  && chown -R 0:0 /home/node \
  && chmod -R a-w /home/node

USER 1000:1000
EXPOSE 3100
CMD ["node", "dist/src/apps/api.js"]
