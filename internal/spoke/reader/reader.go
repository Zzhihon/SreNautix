// Package reader 是分支的只读角色（DESIGN §1.1、§18）：informer、拓扑事件、对账与声明查询。
package reader

import (
	"context"
	"errors"
)

// Run 运行 reader 角色。本角色由 internal/spoke/reader 的实现提供；在它合入之前，以 reader 角色启动会直接失败。
func Run(ctx context.Context, version string, args []string) error {
	return errors.New("the reader role is not part of this build")
}
