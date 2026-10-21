# syntax=docker/dockerfile:1.19@sha256:b6afd42430b15f2d2a4c5a02b919e98a525b785b1aaff16747d2f623364e39b6
# Kind 端到端用的本地 Git 服务（deploy/kind/gitlocal）；只在测试集群中运行，不发布。
# 构建上下文是仓库根目录：docker buildx build -f deploy/docker/gitlocal.Dockerfile .
# 运行镜像需要 git（bare 仓库的读写与 smart HTTP 都调用 git），用 Chainguard 的 git 镜像。

ARG GO_BUILDER=docker.io/library/golang:1.27.3-trixie@sha256:1896654cfc5c2b5ad74c07f29cb36f5d2d1cbed42e3054070fbfe444e521e83c
ARG GIT_RUNTIME=cgr.dev/chainguard/git@sha256:62087eb4f17f6d09e27f4eace690f264e091bbbf0f99c8882dc5b8eae4013bab

FROM --platform=$BUILDPLATFORM ${GO_BUILDER} AS build
ARG TARGETOS
ARG TARGETARCH
ENV CGO_ENABLED=0 \
    GOTOOLCHAIN=local \
    GOFLAGS=-mod=readonly
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download && go mod verify
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -buildvcs=false -ldflags "-s -w -buildid=" \
      -o /out/gitlocal ./deploy/kind/gitlocal

FROM ${GIT_RUNTIME}
COPY --from=build --chown=0:0 --chmod=0555 /out/gitlocal /usr/local/bin/gitlocal
# kind/gitops 仓库的初始内容（-seed kind/gitops=/seed/gitops）
COPY --chown=0:0 deploy/kind/gitops /seed/gitops
USER 65532:65532
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/gitlocal"]
