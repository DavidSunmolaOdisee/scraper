FROM node:20-bullseye
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY server.js ./
EXPOSE 8080
CMD ["node","server.js"]
