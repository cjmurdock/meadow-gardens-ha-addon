# Stage 1: build the queue web app
FROM node:22-bookworm-slim AS web
WORKDIR /build/app
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app/ ./
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# Stage 2: runtime with Python, Playwright Chromium and Node
FROM mcr.microsoft.com/playwright/python:v1.64.1-noble
ENV PYTHONUNBUFFERED=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright NODE_ENV=production
COPY --from=web /usr/local/bin/node /usr/local/bin/node
WORKDIR /opt/meadow
COPY worker/requirements.txt worker/requirements.txt
RUN pip install --no-cache-dir --break-system-packages -r worker/requirements.txt
COPY worker/ worker/
COPY --from=web /build/app/dist app/dist
COPY --from=web /build/app/node_modules app/node_modules
COPY --from=web /build/app/package.json app/package.json
COPY run.sh scheduler.py ./
RUN chmod +x run.sh
CMD ["/opt/meadow/run.sh"]
