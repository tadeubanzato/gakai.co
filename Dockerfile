FROM node:22-alpine AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY client ./client
COPY scripts/build-client.mjs ./scripts/build-client.mjs
COPY public ./public
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./server.mjs
COPY src ./src
COPY --from=frontend /app/public ./public
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(response=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
