# Relais claude-comm — image minimale (zéro dépendance npm).
#   docker build -t claude-comm-relay .
#   docker run -d -p 8787:8787 -v claude-comm-data:/data \
#     -e CLAUDE_COMM_RELAY_SECRET=<jeton> claude-comm-relay
FROM node:22-alpine
WORKDIR /app
COPY relay.js ./
COPY lib ./lib
COPY public ./public
ENV PORT=8787
EXPOSE 8787
VOLUME /data
CMD ["node", "relay.js", "--host", "0.0.0.0", "--data", "/data"]
