FROM oven/bun:1.4.0 AS bun

FROM node:24-bookworm

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /workspace

ENV BUN_INSTALL_CACHE_DIR=/home/bun/.bun/install/cache

CMD ["bun", "run", "--cwd", "station", "station"]
