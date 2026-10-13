# Multi-stage build: compile the client, then run ONE process that serves the client and the game websocket.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json vitest.config.ts ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production PORT=2567
WORKDIR /app
# The server runs TypeScript through tsx, so keep the installed workspace (shared is TypeScript source).
COPY --from=build /app ./
EXPOSE 2567
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||2567)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["npm", "start"]
