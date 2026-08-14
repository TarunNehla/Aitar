# syntax=docker/dockerfile:1
FROM node:22-trixie-slim

ARG PLAYWRIGHT_VERSION=1.62.1

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates dumb-init \
      fonts-liberation fonts-noto-color-emoji fonts-unifont \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 \
      libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 \
      libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 \
      libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 10001 pw \
 && useradd -u 10001 -g 10001 -m -d /home/pw -s /usr/sbin/nologin pw

WORKDIR /app

COPY controller/package.json ./package.json

RUN npm install --omit=dev --no-audit --no-fund \
 && npm ls playwright

RUN install -d -m 0755 -o root -g root /ms-playwright \
 && npx --no playwright install --only-shell chromium \
 && chown -R root:10001 /ms-playwright \
 && chmod -R g+rX,o-rwx /ms-playwright

RUN node -e "require('playwright').chromium.launch({chromiumSandbox:false}).then(b=>b.close()).then(()=>console.log('chromium launch ok'))"

COPY --chown=10001:10001 controller/server.js ./server.js

ENV HOME=/home/pw \
    TMPDIR=/tmp \
    PORT=4000

USER 10001:10001

EXPOSE 4000

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "server.js"]
