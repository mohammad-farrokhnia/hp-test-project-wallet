# syntax=docker/dockerfile:1
# Targets:  runtime (default, what api/worker/migrate run)  |  test (jest, with dev deps)

FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=development

# ---- all dependencies (dev included) ----
FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# ---- compile ----
FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---- production dependencies only ----
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# ---- test target: sources + dev deps, runs jest ----
FROM deps AS test
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
COPY jest.env.js jest.load-env.js jest.global-setup.js ./
CMD ["npm", "test"]

# ---- runtime target (default) ----
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/main"]
