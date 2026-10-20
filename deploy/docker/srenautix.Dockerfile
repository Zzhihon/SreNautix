# syntax=docker/dockerfile:1.19@sha256:b6afd42430b15f2d2a4c5a02b919e98a525b785b1aaff16747d2f623364e39b6
# SreNautix 中心镜像：server、worker、mcp 三个角色（--role=server|worker|mcp）。
# 构建上下文是仓库根目录：docker buildx build -f deploy/docker/srenautix.Dockerfile .
# 基础镜像按 digest 固定；可复现构建依赖 SOURCE_DATE_EPOCH 与 buildx 的 rewrite-timestamp。

ARG NODE_BUILDER=docker.io/library/node:24.22.0-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315
ARG NODE_RUNTIME=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:59c479c9b8c123e66047315c968aa2d35e31ae5149c856e4110a79c8b3563f0b
# integration-sdk 把 PromQL 与 MetricsQL 解析器编译成 wasm，构建阶段需要 Go；版本与 go.mod 的 toolchain 相同
ARG GO_TOOLCHAIN=docker.io/library/golang:1.27.2-trixie@sha256:47667934874913a449b96faa7ef4777fa285d9ec29126ee80ed61c45b7cccf0e

FROM ${GO_TOOLCHAIN} AS go

FROM ${NODE_BUILDER} AS build
ARG SOURCE_DATE_EPOCH
COPY --from=go /usr/local/go /usr/local/go
# node 的 slim 镜像没有 CA 证书，Go 下载模块需要校验 proxy.golang.org 的证书
COPY --from=go /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ENV CI=true \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/pnpm \
    GOTOOLCHAIN=local \
    GOMODCACHE=/go/pkg/mod \
    GOCACHE=/root/.cache/go-build \
    PATH=/pnpm:/usr/local/go/bin:$PATH
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
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    pnpm --filter "{./apps/srenautix}..." --filter "{./web/console}..." run --if-present build
# 镜像内的目录与仓库一致：/app/apps/srenautix（只含运行时依赖）、/app/contract（动作目录等契约文件）、
# /app/packs（内置领域包）、/app/web/console/dist（控制台静态文件）。
# pnpm 9 的 deploy 需要读取包的元数据，不能离线执行；安装的每个第三方包的版本仍取自 pnpm-lock.yaml，
# 内容按锁文件中的 integrity 校验。
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter ./apps/srenautix deploy --prod /out/app/apps/srenautix \
    && cp -R contract /out/app/contract \
    && cp -R packs /out/app/packs \
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
# 冒烟检查：在运行镜像中加载三个角色的全部模块与运维子命令，缺少任何依赖（例如工作区包没有构建产物）都让构建失败；
# 再用不存在的配置启动 server，要求进程走到读取配置这一步并报配置错误；
# 按 chart 的 db bootstrap Job 的参数运行一次，要求参数被接受、进程走到读取 libpq 环境变量这一步
RUN ["/nodejs/bin/node", "--input-type=module", "-e", "for (const m of ['roles/server.js', 'roles/worker.js', 'roles/mcp.js', 'commands.js']) { await import('/app/apps/srenautix/dist/' + m); } const { existsSync } = await import('node:fs'); for (const p of ['/app/contract/gateway/v1/action-catalog.yaml', '/app/packs', '/app/web/console/dist/index.html']) { if (!existsSync(p)) { throw new Error('missing ' + p); } } const { spawnSync } = await import('node:child_process'); const run = (args, env) => { const r = spawnSync('/nodejs/bin/node', ['/app/apps/srenautix/dist/main.js', ...args], { encoding: 'utf8', env }); return { status: r.status, out: r.stdout + r.stderr }; }; const s = run(['--role=server', '--config=/nonexistent/config.yaml'], {}); if (s.status === 0 || !s.out.includes('ConfigError')) { throw new Error('server did not reach config loading: ' + s.out); } const b = run(['db', 'bootstrap', '--admin-password-file=/nonexistent/password'], { PGSSLMODE: 'verify-full' }); if (b.status === 0 || !b.out.includes('PGSSLROOTCERT')) { throw new Error('db bootstrap did not reach the libpq environment: ' + b.out); } console.log('smoke ok');"]
EXPOSE 8080 8081 9090
ENTRYPOINT ["/nodejs/bin/node", "/app/apps/srenautix/dist/main.js"]
