# The self-hosted server. Storage: SQLite files in /data, file contents in an
# S3-compatible store (see compose.yaml).
FROM docker.io/oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src
COPY public ./public
RUN mkdir /data && chown bun:bun /data
USER bun
ENV DATA_DIR=/data PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["bun", "src/runtime/bun/server.ts"]
