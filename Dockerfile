FROM node:22-alpine
WORKDIR /app
COPY . /app
RUN corepack enable && cd /app/server && pnpm install --frozen-lockfile && pnpm run build:auth-client && pnpm prune --prod
ENV NODE_ENV=production PORT=8080 DATA_FILE=/data/rooms.json
RUN mkdir -p /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:8080/api/health || exit 1
CMD ["node", "server/server.js"]
