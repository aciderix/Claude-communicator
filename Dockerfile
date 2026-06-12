# Relais claude-comm + interface React.
#   docker build -t claude-comm-relay .
#   docker run -d -p 8787:8787 -v claude-comm-data:/data \
#     -e CLAUDE_COMM_RELAY_SECRET=<jeton> claude-comm-relay

# étape 1 : construction de l'interface web
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# étape 2 : relais (zéro dépendance) + interface construite
FROM node:22-alpine
WORKDIR /app
COPY relay.js ./
COPY lib ./lib
COPY public ./public
COPY --from=web /web/dist ./web/dist
ENV PORT=8787
EXPOSE 8787
VOLUME /data
CMD ["node", "relay.js", "--host", "0.0.0.0", "--data", "/data"]
