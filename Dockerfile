# ── GST Challan Microservice ──────────────────────────────────────────────────
# Uses official Playwright image — Chromium + all system deps pre-installed
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Copy manifests first (layer cache: only re-runs npm ci when package.json changes)
COPY package*.json ./
COPY tsconfig.json ./

# Install Node dependencies
# Browsers are already at /ms-playwright — no playwright install needed
RUN npm ci

# Copy source
COPY src/ ./src/

# Runtime directories
RUN mkdir -p profiles output

# Railway injects $PORT; default 3001 for local docker run
EXPOSE 3001

CMD ["npx", "ts-node", "src/server.ts"]
