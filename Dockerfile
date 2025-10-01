FROM node:20-bullseye
WORKDIR /app

# alleen package files kopiëren voor betere caching
COPY package*.json ./

# GEEN npm ci (geen lockfile); gebruik install
RUN npm install --omit=dev

# rest van de code
COPY server.js ./

EXPOSE 8080
CMD ["node","server.js"]
