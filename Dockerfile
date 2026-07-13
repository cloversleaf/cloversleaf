# Puppeteer image includes Chromium + deps — required on Railway
FROM ghcr.io/puppeteer/puppeteer:22.15.0

USER root
WORKDIR /app

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    CHROME_PATH=/usr/bin/google-chrome-stable \
    HEADLESS=new \
    HOST=0.0.0.0 \
    LOG_LEVEL=info

# Image already has chrome; confirm path variants
RUN if [ ! -x /usr/bin/google-chrome-stable ] && [ -x /usr/bin/google-chrome ]; then \
      ln -sf /usr/bin/google-chrome /usr/bin/google-chrome-stable; \
    fi; \
    which google-chrome-stable || which google-chrome || which chromium || true

COPY package.json ./
RUN npm install --omit=dev

COPY cloud.js ua.js server.js logger.js ./

# puppeteer image often runs as pptruser
RUN chown -R pptruser:pptruser /app 2>/dev/null || true
USER pptruser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
