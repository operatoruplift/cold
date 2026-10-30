# COLD on a server: the public site with its waitlist, and your app behind
# your login, in one small container. Everything that is yours (cold.yaml,
# .env.local, the database, prospect lists, the message library) lives in
# /data: mount a persistent volume there. See docs/deploy.md.
FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
ENV NODE_ENV=production \
    COLD_HOME=/data \
    COLD_REQUIRE_PUBLIC_URL=1 \
    PORT=4100
VOLUME /data
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4100) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["bun", "src/domains/web/server/index.ts", "--no-open"]
