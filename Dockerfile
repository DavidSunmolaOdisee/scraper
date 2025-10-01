# heeft Chromium + alle vereiste libs al ingebakken
FROM ghcr.io/puppeteer/puppeteer:22.6.0

WORKDIR /app

# alleen package files voor cache
COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./

# puppeteer-image zet deze env var automatisch:
# PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 8080
CMD ["node","server.js"]
