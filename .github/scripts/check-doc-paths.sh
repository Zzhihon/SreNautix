#!/usr/bin/env bash
# 检查文档里用反引号写的仓库路径都存在，防止仓库地图过期。
# 只检查形如路径的词：含 "/"、不含空格与通配符、不以 "-"、"/"、"." 开头，也不是 URL 或 shell 片段。
# 用法：check-doc-paths.sh <文档>...
set -euo pipefail

tick=$(printf '\x60')
status=0
for doc in "$@"; do
  while IFS= read -r p; do
    p=${p%/}
    if [[ ! -e "$p" ]]; then
      echo "::error file=$doc::$doc 引用的路径不存在：$p"
      status=1
    fi
  done < <(grep -oE "${tick}[^${tick} ]+${tick}" "$doc" | tr -d "$tick" | grep '/' |
    grep -vE '^[-/.~$]|://|[*<>{}()=|]|^@|^[A-Z_]+=' | sort -u)
done
exit "$status"
