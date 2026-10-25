# ---------------------------------------------------------------------------
# Stage 1 — build TypeScript
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — runtime (Playwright + Chromium, headless only)
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.52.0-noble AS runtime

USER root
RUN mkdir -p /app/profile /app/output /host-profile && chown -R pwuser:pwuser /app

USER pwuser
WORKDIR /app

COPY --chown=pwuser:pwuser --from=builder /app/dist ./dist
COPY --chown=pwuser:pwuser --from=builder /app/node_modules ./node_modules
COPY --chown=pwuser:pwuser package.json ./

# Chromium executable — glob resolved at runtime via child_process find
ENV BROWSER_EXECUTABLE_PATH=/ms-playwright/chromium-*/chrome-linux/chrome

ARG GIT_SHA=dev

ENV GIT_SHA=${GIT_SHA} \
    PORT=3100 \
    HEADLESS=true \
    LOG_LEVEL=info \
    RESPONSE_TIMEOUT_MS=120000 \
    SELECTOR_TIMEOUT_MS=30000 \
    PROFILE_DIR=/app/profile \
    HOST_PROFILE_DIR=/host-profile \
    OUTPUT_DIR=/app/output

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3100/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
