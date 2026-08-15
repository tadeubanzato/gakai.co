FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./server.mjs
COPY public ./public
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
