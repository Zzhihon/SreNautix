#!/usr/bin/env bash
# 在 GitHub Actions 的 ubuntu-24.04 runner 上安装 TS 测试依赖的真实服务二进制（linux/amd64），全部按 sha256 或 digest 固定：
#   Prometheus 与 promtool、Alertmanager、VictoriaMetrics 与 vmalert → $BIN_DIR（加入 PATH，并设为 SRENAUTIX_TEST_BIN）
#   MinIO（取自按 digest 固定的镜像，静态链接）→ $BIN_DIR/minio（SRENAUTIX_MINIO_BIN）
#   PostgreSQL 18（PGDG 软件源）→ /usr/lib/postgresql/18/bin（SRENAUTIX_PG_BIN）
# 用法：install-test-binaries.sh <BIN_DIR>
set -euo pipefail

bin_dir=${1:?用法：install-test-binaries.sh <BIN_DIR>}
mkdir -p "$bin_dir"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

PROMETHEUS_VERSION=3.15.0
PROMETHEUS_SHA256=2a542df32eac02ee17b9d844fb2aa1de00dafa5476579ba8a3ba862e9d572ea0
ALERTMANAGER_VERSION=0.34.1
ALERTMANAGER_SHA256=265b9d1e55ef0d5306a436018af6d2b686c2ce051f03d968f7464ecb1372a7e8
VM_VERSION=v1.154.0
VM_SHA256=2ba3edae969a4b52a55e78d2721067541b0ee94774190dbd87fea0602aa57b8f
VMUTILS_SHA256=0c6b01fba8ca3149a017ad7713ae65cd2222ba6a64f1e1f8787692cbb5d953c9
# 与 deploy/helm/srenautix/values.yaml 中 audit.minio.image 相同的镜像
MINIO_IMAGE=cgr.dev/chainguard/minio@sha256:2915cb406f38ed6ff9634de0a3e4a9423e2dda06a6f1aca18f8c968aa37a01f6
PG_MAJOR=18

fetch() {
  local url=$1 sha=$2 out=$3
  curl -fsSLo "$out" "$url"
  echo "$sha  $out" | sha256sum --check --quiet
}

fetch "https://github.com/prometheus/prometheus/releases/download/v${PROMETHEUS_VERSION}/prometheus-${PROMETHEUS_VERSION}.linux-amd64.tar.gz" \
  "$PROMETHEUS_SHA256" "$work/prometheus.tgz"
tar -xzf "$work/prometheus.tgz" -C "$work"
install -m 0755 "$work/prometheus-${PROMETHEUS_VERSION}.linux-amd64/prometheus" "$work/prometheus-${PROMETHEUS_VERSION}.linux-amd64/promtool" "$bin_dir/"

fetch "https://github.com/prometheus/alertmanager/releases/download/v${ALERTMANAGER_VERSION}/alertmanager-${ALERTMANAGER_VERSION}.linux-amd64.tar.gz" \
  "$ALERTMANAGER_SHA256" "$work/alertmanager.tgz"
tar -xzf "$work/alertmanager.tgz" -C "$work"
install -m 0755 "$work/alertmanager-${ALERTMANAGER_VERSION}.linux-amd64/alertmanager" "$bin_dir/"

fetch "https://github.com/VictoriaMetrics/VictoriaMetrics/releases/download/${VM_VERSION}/victoria-metrics-linux-amd64-${VM_VERSION}.tar.gz" \
  "$VM_SHA256" "$work/vm.tgz"
tar -xzf "$work/vm.tgz" -C "$bin_dir" victoria-metrics-prod
fetch "https://github.com/VictoriaMetrics/VictoriaMetrics/releases/download/${VM_VERSION}/vmutils-linux-amd64-${VM_VERSION}.tar.gz" \
  "$VMUTILS_SHA256" "$work/vmutils.tgz"
tar -xzf "$work/vmutils.tgz" -C "$bin_dir" vmalert-prod

cid=$(docker create --platform linux/amd64 "$MINIO_IMAGE")
docker cp "$cid:/usr/bin/minio" "$bin_dir/minio"
docker rm "$cid" >/dev/null
chmod 0755 "$bin_dir/minio"

sudo apt-get update -qq
sudo apt-get install -y -qq postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt-get install -y -qq "postgresql-${PG_MAJOR}"

"$bin_dir/prometheus" --version | head -1
"$bin_dir/alertmanager" --version | head -1
"$bin_dir/minio" --version | head -1
"/usr/lib/postgresql/${PG_MAJOR}/bin/initdb" --version

if [[ -n "${GITHUB_ENV:-}" ]]; then
  {
    echo "SRENAUTIX_TEST_BIN=$bin_dir"
    echo "SRENAUTIX_MINIO_BIN=$bin_dir/minio"
    echo "SRENAUTIX_PG_BIN=/usr/lib/postgresql/${PG_MAJOR}/bin"
  } >>"$GITHUB_ENV"
  echo "$bin_dir" >>"$GITHUB_PATH"
fi
