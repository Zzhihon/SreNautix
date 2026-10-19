# Go 部分（spoke：reader 与 gateway）的构建与测试入口。依赖的二进制下载到被忽略的 .scratch/ 与 .envtest/。

GO                  ?= go
ENVTEST_K8S_VERSION ?= 1.37.0
SETUP_ENVTEST       := $(CURDIR)/.scratch/bin/setup-envtest
ENVTEST_DIR         := $(CURDIR)/.envtest
VERSION             ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

.PHONY: go-build go-vet go-test go-vectors-check envtest-assets

go-build:
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o bin/srenautix-spoke ./cmd/srenautix-spoke

go-vet:
	$(GO) vet ./...

$(SETUP_ENVTEST):
	GOBIN=$(CURDIR)/.scratch/bin $(GO) install sigs.k8s.io/controller-runtime/tools/setup-envtest@release-0.23

envtest-assets: $(SETUP_ENVTEST)
	$(SETUP_ENVTEST) use $(ENVTEST_K8S_VERSION) --bin-dir $(ENVTEST_DIR) -p path

# 测试向量必须与生成器的输出逐字节一致
go-vectors-check:
	$(GO) run ./hack/gen-gateway-vectors
	git diff --exit-code -- contract/gateway/v1/testvectors

go-test: $(SETUP_ENVTEST) go-vet go-vectors-check
	KUBEBUILDER_ASSETS="$$($(SETUP_ENVTEST) use $(ENVTEST_K8S_VERSION) --bin-dir $(ENVTEST_DIR) -p path)" \
		$(GO) test -count=1 ./...
