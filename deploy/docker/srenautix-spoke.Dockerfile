# syntax=docker/dockerfile:1.19@sha256:b6afd42430b15f2d2a4c5a02b919e98a525b785b1aaff16747d2f623364e39b6
# SreNautix 分支镜像：reader、gateway 两个角色（--role=reader|gateway）。
# 构建上下文是仓库根目录：docker buildx build -f deploy/docker/srenautix-spoke.Dockerfile .
# 在构建平台上交叉编译，不经过 QEMU；-trimpath、空 buildid 与 SOURCE_DATE_EPOCH 保证可复现。

ARG GO_BUILDER=docker.io/library/golang:1.27.2-trixie@sha256:47667934874913a449b96faa7ef4777fa285d9ec29126ee80ed61c45b7cccf0e
ARG STATIC_RUNTIME=gcr.io/distroless/static-debian13:nonroot@sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3

FROM --platform=$BUILDPLATFORM ${GO_BUILDER} AS build
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
ENV CGO_ENABLED=0 \
    GOTOOLCHAIN=local \
    GOFLAGS=-mod=readonly
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download && go mod verify
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -buildvcs=false \
      -ldflags "-s -w -buildid= -X main.version=${VERSION}" \
      -o /out/srenautix-spoke ./cmd/srenautix-spoke

FROM ${STATIC_RUNTIME}
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="srenautix-spoke" \
      org.opencontainers.image.description="SreNautix spoke: reader and gateway roles" \
      org.opencontainers.image.source="https://github.com/Zzhihon/SreNautix" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
COPY --from=build --chown=0:0 --chmod=0555 /out/srenautix-spoke /srenautix-spoke
USER 65532:65532
EXPOSE 8080 8081 9090
ENTRYPOINT ["/srenautix-spoke"]
