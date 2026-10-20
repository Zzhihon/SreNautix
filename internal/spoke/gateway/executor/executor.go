// Package executor 实现动作目录中每个动作的执行器（DESIGN §9.1）：解析目标并计算预检、执行写入、
// 崩溃恢复时观察是否已生效、执行后校验、撤销或给出补偿。执行器只写入目录 writes 声明的对象，
// 每次修改都带 resourceVersion 前置条件与 srenautix.io/execution-id 注解。
package executor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/audit"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/catalog"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/github"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/kube"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/metrics"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/policy"
)

// Deps 是执行器的依赖。
type Deps struct {
	Kube    *kube.Client
	Catalog *catalog.Catalog
	Policy  func() *policy.Policy
	// GitHub 为 nil 时 gitops_pr 的预检失败。
	GitHub *github.App
	// MainWatchdog 返回仓库 base 分支的 watchdog 状态（ok 为 false 时 gitops_pr 预检 main_watchdog 失败）；nil 时视为失败。
	MainWatchdog func(repository string) (ok bool, detail string)
	// Metrics 为 nil 时不记指标（单元测试）。
	Metrics *metrics.Metrics
	Now     func() time.Time
	// Poll 是分步动作等待目标恢复时的轮询间隔。
	Poll time.Duration
}

// Resolved 是目标的当前状态与预检结果。
type Resolved struct {
	Target          execution.TargetRef
	ResourceVersion string
	Domain          string
	// Level 是按当前状态确定的等级（pod_restart 不满足可重建条件时为 irreversible）。
	Level string
	// NeedsH 表示目标状态要求 H 档（例如滚动重建时 PDB 没有余量）。
	NeedsH      bool
	BlastRadius int64
	// Nodes 与 PGCluster 用于判断目标是否落在 SreNautix 自身的依赖集合中。
	Nodes     []string
	PGCluster *[2]string
	Prechecks []execution.CheckResult
	Snapshot  map[string]any
}

// Passed 表示全部预检通过。
func (r *Resolved) Passed() bool {
	for _, c := range r.Prechecks {
		if !c.Passed {
			return false
		}
	}
	return true
}

// Failed 返回未通过的预检。
func (r *Resolved) Failed() string {
	var out []string
	for _, c := range r.Prechecks {
		if !c.Passed {
			out = append(out, c.ID+": "+c.Detail)
		}
	}
	return strings.Join(out, "; ")
}

// Exec 是一次执行的上下文。
type Exec struct {
	AE       *execution.ActionExecution
	Params   json.RawMessage
	Snapshot map[string]any
	// Progress 在分步动作的每一步副作用之前持久化步骤标识。
	Progress func(ctx context.Context, step string) error
	// Wrote 在每次写入之后记录到执行审计链。
	Wrote func(ctx context.Context, target audit.Target, verb string, err error) error
}

// ID 返回执行 ID。
func (x *Exec) ID() string { return x.AE.Spec.ExecutionID }

// Observation 是崩溃恢复时对目标的观察结果。
type Observation int

const (
	// NotApplied 表示副作用没有发生。
	NotApplied Observation = iota
	// Applied 表示副作用已经完整发生。
	Applied
	// Partial 表示分步动作只完成了一部分，由人判断（indeterminate）。
	Partial
)

// ErrTargetNotFound 表示目标不存在。
var ErrTargetNotFound = errors.New("target not found")

// ErrUndoConflict 表示目标在执行之后又被别人修改，撤销会覆盖别人的修改，转为 needs_human。
var ErrUndoConflict = errors.New("target changed after execution")

// ErrNoUndo 表示该动作不能自动恢复原状态。
var ErrNoUndo = errors.New("action has no automatic undo")

// Executor 是一个目录动作的实现。
type Executor interface {
	Resolve(ctx context.Context, params json.RawMessage) (*Resolved, error)
	Execute(ctx context.Context, x *Exec) error
	Observe(ctx context.Context, x *Exec) (Observation, string, error)
	Verify(ctx context.Context, x *Exec) ([]execution.CheckResult, error)
	Undo(ctx context.Context, x *Exec) (string, error)
	// Compensation 返回 compensable 动作校验失败后建议的补偿动作；其余动作返回 nil。
	Compensation(x *Exec) *execution.Compensation
}

// Registry 返回动作 ID 到执行器的映射；目录中的每个动作都必须有执行器，反之亦然（不变量 2）。
func Registry(d *Deps) (map[string]Executor, error) {
	r := map[string]Executor{
		"pod_restart":                    &podRestart{d: d},
		"workload_rolling_restart":       &rollingRestart{d: d},
		"workload_scale":                 workloadScale(d),
		"hpa_bounds_set":                 hpaBounds(d),
		"rollout_pause":                  rolloutToggle(d, true),
		"rollout_resume":                 rolloutToggle(d, false),
		"cronjob_suspend":                cronJobToggle(d, true),
		"cronjob_resume":                 cronJobToggle(d, false),
		"node_cordon":                    nodeCordon(d),
		"node_uncordon":                  nodeUncordon(d),
		"cnpg_replica_restart":           &cnpgReplicaRestart{d: d},
		"cnpg_switchover":                &cnpgSwitchover{d: d},
		"argocd_app_sync":                &argoSync{d: d},
		"argocd_app_terminate_operation": &argoTerminate{d: d},
		"argocd_autosync_suspend":        autosyncToggle(d, false),
		"argocd_autosync_resume":         autosyncToggle(d, true),
		"flux_suspend":                   fluxToggle(d, true),
		"flux_resume":                    fluxToggle(d, false),
		"flux_reconcile":                 &fluxReconcile{d: d},
		"workflow_submit":                &workflowSubmit{d: d},
		"workflow_terminate":             &workflowTerminate{d: d},
		"gitops_pr":                      &gitopsPR{d: d},
	}
	for _, a := range d.Catalog.Actions {
		if _, ok := r[a.ID]; !ok {
			return nil, fmt.Errorf("executor: catalog action %s has no executor", a.ID)
		}
	}
	for id := range r {
		if _, ok := d.Catalog.Get(id); !ok {
			return nil, fmt.Errorf("executor: executor %s is not in the catalog", id)
		}
	}
	return r, nil
}

// ── 通用工具 ────────────────────────────────────────────────────────

func decode(params json.RawMessage, v any) error {
	if err := json.Unmarshal(params, v); err != nil {
		return fmt.Errorf("params: %w", err)
	}
	return nil
}

func check(id, kind string, passed bool, format string, args ...any) execution.CheckResult {
	return execution.CheckResult{ID: id, Kind: kind, Passed: passed, Detail: fmt.Sprintf(format, args...)}
}

func nestedString(obj map[string]any, fields ...string) string {
	s, _, _ := unstructured.NestedString(obj, fields...)
	return s
}

// escapePointer 按 RFC 6901 转义 JSON Pointer 的一段。
func escapePointer(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "~", "~0"), "/", "~1")
}

func pointer(path []string) string {
	parts := make([]string, len(path))
	for i, p := range path {
		parts[i] = escapePointer(p)
	}
	return "/" + strings.Join(parts, "/")
}

// annotationOps 返回给对象加上执行 ID 注解（与其他注解）的 JSON Patch 操作。
func annotationOps(obj *unstructured.Unstructured, set map[string]string) []map[string]any {
	if len(obj.GetAnnotations()) == 0 {
		m := map[string]any{}
		for k, v := range set {
			m[k] = v
		}
		return []map[string]any{{"op": "add", "path": "/metadata/annotations", "value": m}}
	}
	var ops []map[string]any
	for k, v := range set {
		ops = append(ops, map[string]any{"op": "add", "path": "/metadata/annotations/" + escapePointer(k), "value": v})
	}
	return ops
}

func testRV(rv string) map[string]any {
	return map[string]any{"op": "test", "path": "/metadata/resourceVersion", "value": rv}
}

func snapshotString(s map[string]any, key string) string {
	v, _ := s[key].(string)
	return v
}

// SnapshotResourceVersion 是快照中目标 resourceVersion 的键；引擎在写入快照时加入，执行器据此带前置条件写入。
const SnapshotResourceVersion = "resourceVersion"

func rawExt(b []byte) runtime.RawExtension { return runtime.RawExtension{Raw: b} }
