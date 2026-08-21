FROM node:24.19.0-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build

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

FROM node:24.19.0-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime

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
