FROM node:20-bookworm-slim AS build
ARG APP_COMMIT=development
ENV APP_COMMIT=$APP_COMMIT
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build && npm run web:build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim
ARG APP_COMMIT=development
ENV NODE_ENV=production APP_COMMIT=$APP_COMMIT
LABEL org.opencontainers.image.revision=$APP_COMMIT
WORKDIR /app

# Debian 12 (bookworm) ships MariaDB 10.11, matching the previous collector-db
# image. policy-rc.d stops package postinst scripts from starting services
# during the image build; supervisord starts everything at container runtime.
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
 && chmod +x /usr/sbin/policy-rc.d \
 && apt-get update \
 && apt-get install -y --no-install-recommends mariadb-server mariadb-client supervisor \
 && rm -rf /var/lib/apt/lists/* /usr/sbin/policy-rc.d \
 && mkdir -p /run/mysqld /data/blobs /data/exports \
 && chown -R mysql:mysql /run/mysqld \
 && chown -R node:node /data

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/packages ./packages
COPY docker/mariadb-server.cnf /etc/mysql/mariadb.conf.d/99-collector.cnf
COPY docker/supervisord.conf /etc/supervisor/conf.d/collector.conf
COPY docker/start-mariadb.sh /usr/local/bin/start-mariadb.sh
COPY docker/init-mariadb.sh /usr/local/bin/init-mariadb.sh
COPY docker/wait-for-mariadb.sh /usr/local/bin/wait-for-mariadb.sh
RUN chmod +x /usr/local/bin/start-mariadb.sh /usr/local/bin/init-mariadb.sh /usr/local/bin/wait-for-mariadb.sh

EXPOSE 8080
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf", "-n"]
