# syntax=docker/dockerfile:1.19
# SreNautix 中心镜像：server、worker、mcp 三个角色（--role=server|worker|mcp）。
# 构建上下文是仓库根目录：docker buildx build -f deploy/docker/srenautix.Dockerfile .
# 基础镜像按 digest 固定；可复现构建依赖 SOURCE_DATE_EPOCH 与 buildx 的 rewrite-timestamp。

ARG NODE_BUILDER=docker.io/library/node:24.22.0-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315
ARG NODE_RUNTIME=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:59c479c9b8c123e66047315c968aa2d35e31ae5149c856e4110a79c8b3563f0b

FROM ${NODE_BUILDER} AS build
ARG SOURCE_DATE_EPOCH
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
WORKDIR /src
# pnpm 版本取自根目录 package.json 的 packageManager 字段
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack install
# 先按锁文件下载依赖，源码变化时复用这一层缓存
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline
# 构建中心进程及其依赖的工作区包；控制台前端由 server 进程提供，与中心进程一起构建
RUN pnpm --filter "./apps/srenautix..." --filter "./web/console..." run --if-present build
# 只保留运行时依赖
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter ./apps/srenautix deploy --prod --offline /out/app \
    && mkdir -p /out/app/web/console \
    && cp -R web/console/dist /out/app/web/console/dist
# 统一文件时间戳，保证同一提交的构建结果逐字节一致
RUN find /out -exec touch -h -d "@${SOURCE_DATE_EPOCH:-0}" {} +

FROM ${NODE_RUNTIME}
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="srenautix" \
      org.opencontainers.image.description="SreNautix hub: server, worker and mcp roles" \
      org.opencontainers.image.source="https://github.com/Zzhihon/SreNautix" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
ENV NODE_ENV=production \
    SRENAUTIX_VERSION=${VERSION} \
    SRENAUTIX_CONSOLE_DIR=/app/web/console/dist
WORKDIR /app
COPY --from=build --chown=65532:65532 /out/app /app
USER 65532:65532
EXPOSE 8080 8081 9090
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/main.js"]
