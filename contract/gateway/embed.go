// Package gateway 嵌入 contract/gateway/v1 中与语言无关的契约文件（JSON Schema、OpenAPI、动作目录、CRD、测试向量），
// 供 Go 侧的 spoke 加载；TypeScript 侧直接读取同一批文件。
package gateway

import "embed"

// FS 包含 v1 目录下的全部契约文件。
//
//go:embed v1
var FS embed.FS

// SchemaBase 是 v1 目录中各 schema 的 $id 前缀；相对 $ref 按它解析。
const SchemaBase = "https://srenautix.io/contract/gateway/v1/"
