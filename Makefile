# Go 部分（spoke：reader 与 gateway）的构建、生成与测试入口。依赖的二进制下载到被忽略的 .scratch/ 与 .envtest/。

GO                  ?= go
ENVTEST_K8S_VERSION ?= 1.37.0
SETUP_ENVTEST       := $(CURDIR)/.scratch/bin/setup-envtest
CONTROLLER_GEN      := $(CURDIR)/.scratch/bin/controller-gen
ENVTEST_DIR         := $(CURDIR)/.envtest
GO_TMPDIR           := $(CURDIR)/.scratch/tmp
VERSION             ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

# 生成结果所在的路径；gateway-generate-check 要求重新生成后这些路径没有差异
GATEWAY_GENERATED := contract/gateway/v1/crd contract/gateway/v1/testvectors deploy/helm/srenautix/crds deploy/helm/srenautix/files/admission

.PHONY: go-build go-vet go-test gateway-generate gateway-generate-check envtest-assets

go-build:
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o bin/srenautix-spoke ./cmd/srenautix-spoke

go-vet:
	$(GO) vet ./...

$(SETUP_ENVTEST):
	GOBIN=$(CURDIR)/.scratch/bin $(GO) install sigs.k8s.io/controller-runtime/tools/setup-envtest@release-0.23

$(CONTROLLER_GEN):
	GOBIN=$(CURDIR)/.scratch/bin $(GO) install sigs.k8s.io/controller-tools/cmd/controller-gen@v0.20.1

envtest-assets: $(SETUP_ENVTEST)
	$(SETUP_ENVTEST) use $(ENVTEST_K8S_VERSION) --bin-dir $(ENVTEST_DIR) -p path

# ActionExecution CRD（controller-gen，来自 internal/spoke/gateway/execution）、准入策略与 index.yaml（动作目录）、审批断言测试向量
gateway-generate: $(CONTROLLER_GEN)
	$(CONTROLLER_GEN) crd paths=./internal/spoke/gateway/execution/... output:crd:dir=contract/gateway/v1/crd
	$(CONTROLLER_GEN) crd paths=./internal/spoke/gateway/execution/... output:crd:dir=deploy/helm/srenautix/crds
	$(GO) run ./hack/gen-gateway-admission
	$(GO) run ./hack/gen-gateway-vectors

gateway-generate-check: gateway-generate
	git diff --exit-code -- $(GATEWAY_GENERATED)
	@test -z "$$(git status --porcelain --untracked-files=all -- $(GATEWAY_GENERATED))" || \
		{ git status --porcelain --untracked-files=all -- $(GATEWAY_GENERATED); echo "generated files are not committed"; exit 1; }

go-test: $(SETUP_ENVTEST) go-vet gateway-generate-check
	mkdir -p $(GO_TMPDIR)
	TMPDIR=$(GO_TMPDIR) KUBEBUILDER_ASSETS="$$($(SETUP_ENVTEST) use $(ENVTEST_K8S_VERSION) --bin-dir $(ENVTEST_DIR) -p path)" \
		$(GO) test -count=1 ./...
