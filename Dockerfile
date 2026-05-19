# ── GST Challan Microservice ──────────────────────────────────────────────────
# Uses official Playwright image — Chromium + all system deps pre-installed
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Copy manifests first (layer cache: only re-runs npm ci when package.json changes)
COPY package*.json ./
COPY tsconfig.json ./

# Install all deps (devDeps needed for tsc compile step below)
RUN npm ci

# Copy source and compile TypeScript → CommonJS JavaScript
# This avoids ts-node's ESM incompatibility with modern packages at runtime
COPY src/ ./src/
RUN npx tsc

# Runtime directories
RUN mkdir -p profiles output

# Railway injects $PORT; default 3001 for local docker run
EXPOSE 3001

# Run the compiled JS — no ts-node, no ESM issues
CMD ["node", "dist/server.js"]
