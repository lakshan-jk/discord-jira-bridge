# syntax=docker/dockerfile:1

# ---- Build stage: install all deps (incl. dev) and compile TypeScript ----
FROM node:22-alpine AS builder
WORKDIR /app

# Install against the lockfile for a reproducible build.
COPY package.json package-lock.json ./
RUN npm ci

# Compile src -> dist.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage: slim image with only production deps + built output ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only — no TypeScript, vitest, eslint, etc.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Built JavaScript from the builder stage.
COPY --from=builder /app/dist ./dist

# Run as the image's built-in unprivileged user.
RUN chown -R node:node /app
USER node

# Health endpoint (design #8). PORT is configurable; 3000 is the default.
EXPOSE 3000

# Loads .env if one is mounted, but otherwise relies on the environment the
# container is given (e.g. docker-compose). No crash when .env is absent.
CMD ["node", "--env-file-if-exists=.env", "dist/index.js"]
