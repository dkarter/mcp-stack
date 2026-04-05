FROM oven/bun:1-alpine

WORKDIR /app
COPY server.ts /app/server.ts
COPY ui /app/ui

EXPOSE 8090

CMD ["bun", "/app/server.ts"]
