# Node 22 ships a built-in WebSocket client and fetch, so there are no npm dependencies.
FROM node:22-alpine

WORKDIR /app
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8099
CMD ["node", "server.js"]
