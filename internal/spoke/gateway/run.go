// Package gateway 是分支的写角色（DESIGN §9.4）：拉取已批准的工单，校验断言、策略、绑定与预检，
// 先写 ActionExecution 再执行，按声明的条件校验，必要时撤销，并维护执行审计链。
package gateway

import (
	"context"
	"errors"
)

// Run 运行 gateway 角色。
func Run(ctx context.Context, version string, args []string) error {
	return errors.New("the gateway role is not part of this build")
}
