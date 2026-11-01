# Build both the API and the Admin bundle in one stage, then publish two images.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.mjs campaigns.json ./
COPY apps ./apps
COPY assets ./assets
COPY db ./db
COPY flex ./flex
RUN npm run build

FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/campaigns.json ./campaigns.json
COPY --from=build --chown=node:node /app/flex ./flex
USER node
EXPOSE 8787
CMD ["node", "dist/api/server.js"]

FROM nginx:1.27-alpine AS admin
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/admin /usr/share/nginx/html
EXPOSE 8080
