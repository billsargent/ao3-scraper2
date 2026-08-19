FROM node:20-bookworm-slim AS build
ARG APP_COMMIT=development
ENV APP_COMMIT=$APP_COMMIT
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build && npm run web:build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS app
ARG APP_COMMIT=development
ENV NODE_ENV=production APP_COMMIT=$APP_COMMIT
LABEL org.opencontainers.image.revision=$APP_COMMIT
WORKDIR /app
RUN mkdir -p /data/blobs /data/exports && chown -R node:node /data
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/packages ./packages
USER node

FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
