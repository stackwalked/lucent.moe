ARG BUN_IMAGE
FROM ${BUN_IMAGE} AS workspace
WORKDIR /app
COPY package.json bun.lock ./
COPY .config/tsconfig.base.json ./.config/
COPY platform/packages ./platform/packages
COPY platform/server/package.json ./platform/server/
COPY web/package.json ./web/

FROM workspace AS platform-server
RUN bun install --frozen-lockfile --production --filter @lucent/server
COPY platform/server ./platform/server
COPY products ./products
WORKDIR /app/platform/server
CMD ["sh", "-c", "umask 0007; exec bun src/main.ts"]

FROM workspace AS web-build
RUN bun install --frozen-lockfile
COPY web ./web
WORKDIR /app/web
RUN bun dev/routes.ts && bun dev/generate.ts && bun --bun vite build

FROM workspace AS web
RUN bun install --frozen-lockfile --production --filter @lucent/web
COPY --from=web-build /app/web/src ./web/src
COPY --from=web-build /app/web/dist ./web/dist
WORKDIR /app/web
CMD ["sh", "-c", "umask 0007; exec bun src/main.ts"]
