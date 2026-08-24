FROM node:22-alpine AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY client ./client
COPY scripts/build-client.mjs ./scripts/build-client.mjs
COPY public ./public
RUN npm run build

# Test-only stage: adds the backend and its tests on top of the already
# npm-ci'd frontend stage. Never referenced by the final runtime image below,
# so it has no effect on what gets shipped/pulled.
FROM frontend AS test
COPY server.mjs ./server.mjs
COPY src ./src
COPY test ./test
CMD ["npm", "test"]

# Gakai's WhatsApp connectivity is a direct, in-process integration — no
# separate provider process or browser runtime, so the release image is
# plain Node with Gakai's own production dependencies only.
FROM node:22-alpine
WORKDIR /gakai
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs ./server.mjs
COPY src ./src
COPY --from=frontend /build/public ./public

ENV PORT=3001
ENV HOME_DATA_DIR=/data
ENV GAKAI_SESSIONS_DIR=/sessions
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(response=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
