# Cadence web — multi-stage build (node:22-alpine).
# Build context is the REPO ROOT (see docker-compose.yml) so the workspace
# packages under packages/* are available to the Next build.
# syntax=docker/dockerfile:1

# --- deps: install the whole npm-workspaces graph from the lockfile ----------
FROM node:22-alpine AS deps
WORKDIR /app
# Copy root manifests + lockfile first, then every workspace's package.json so
# `npm ci` can resolve the workspace graph without the source (better caching).
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/director/package.json ./packages/director/
COPY packages/enhance/package.json ./packages/enhance/
COPY packages/render-ffmpeg/package.json ./packages/render-ffmpeg/
COPY packages/render-node/package.json ./packages/render-node/
COPY packages/understanding/package.json ./packages/understanding/
COPY apps/web/package.json ./apps/web/
RUN npm ci

# --- build: compile the Next.js app -----------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run -w @cadence/web build

# --- runner: run the production server ---------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# DATABASE_URL / SESSION_SECRET are injected at runtime by docker-compose.
COPY --from=build /app ./
EXPOSE 3000
WORKDIR /app/apps/web
# `next start` binds 0.0.0.0:3000 by default.
CMD ["npm", "run", "start"]
