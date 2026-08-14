FROM node:24.18.1-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS build

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

FROM node:24.18.1-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS runtime

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
