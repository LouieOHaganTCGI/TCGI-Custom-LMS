# TCGI LMS: container image for staging and production (ADR-0003: containers only, portable across providers).
# One image, two process types: `web` (app + content origins) and `worker` (outbox dispatcher).
# The official Node image. Override NODE_IMAGE to use a registry mirror (for example public.ecr.aws/docker/library/node:22-bookworm-slim).
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Optional build secret "extra_ca": trust a TLS-intercepting build proxy's CA only while installing. It is never stored in the image.
RUN --mount=type=secret,id=extra_ca,required=false NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY scripts/copy-assets.mjs scripts/
COPY src src
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=extra_ca,required=false NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist dist
# Package blobs live on a mounted volume locally. In the cloud they go to object storage (not yet implemented, see docs).
RUN mkdir -p /app/var/blobs && chown -R node:node /app/var
USER node
EXPOSE 3000 3001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.APP_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]
