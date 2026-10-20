package engine

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"sort"
	"strings"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/admission"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/metrics"
	"github.com/Zzhihon/SreNautix/internal/spoke/tunnel"
)

// probeShorts 返回启用动作用到的准入策略短名（与 internal/spoke/gateway/admission 的 index 一致）；
// 启用了 workflow_submit 时加上白名单策略。
func (e *Engine) probeShorts() ([]string, error) {
	out, err := admission.Generate(e.d.Catalog, admission.Options{Username: "probe", Prefix: e.cfg.AdmissionPolicyPrefix})
	if err != nil {
		return nil, err
	}
	enabled := e.currentPolicy().Enabled()
	shorts := out.ProbeNames(enabled)
	for _, a := range enabled {
		if a == "workflow_submit" {
			shorts = append(shorts, admission.WorkflowAllowlistShort)
		}
	}
	sort.Strings(shorts)
	return shorts, nil
}

// selfCheckResult 是最近一次准入自检：时间（本机单调时钟）、探测的策略短名集合与结果。
type selfCheckResult struct {
	at     time.Time
	shorts string
	err    error
}

// SelfCheck 立即为每个启用的准入策略提交一次带探针标签的 dryRun 创建，要求被该策略拒绝（DESIGN §9.4、不变量 3），并记下结果。
// 任何一个被放行或被其他原因拒绝，返回错误。每次执行之前都调用它。
func (e *Engine) SelfCheck(ctx context.Context) error {
	shorts, err := e.probeShorts()
	if err != nil {
		return err
	}
	err = e.probe(ctx, shorts)
	e.mu.Lock()
	e.selfCheck = selfCheckResult{at: time.Now(), shorts: strings.Join(shorts, ","), err: err}
	e.mu.Unlock()
	return err
}

// periodicSelfCheck 是安全检查中的自检（ADR 0024）：上一次自检通过、启用的策略集合没有变化、距上一次不到 SelfCheckInterval 时
// 沿用上一次的结果，不发请求；首次运行、集合变化、上一次失败或间隔已到时立即探测。
func (e *Engine) periodicSelfCheck(ctx context.Context) error {
	shorts, err := e.probeShorts()
	if err != nil {
		return err
	}
	e.mu.Lock()
	last := e.selfCheck
	e.mu.Unlock()
	if !last.at.IsZero() && last.err == nil && last.shorts == strings.Join(shorts, ",") && time.Since(last.at) < e.cfg.SelfCheckInterval {
		return nil
	}
	return e.SelfCheck(ctx)
}

// probe 提交探针。探针是 dryRun=All 的 ActionExecution 创建，名称固定为 32 个 0，带 srenautix.io/admission-probe=<短名> 标签。
func (e *Engine) probe(ctx context.Context, shorts []string) error {
	var failed []string
	for _, s := range shorts {
		name := e.cfg.AdmissionPolicyPrefix + "-gateway-" + s
		err := e.store.DryRunCreate(ctx, admission.ProbeObject(e.cfg.Namespace, s))
		denied := err != nil && (apierrors.IsForbidden(err) || apierrors.IsInvalid(err)) &&
			strings.Contains(err.Error(), "ValidatingAdmissionPolicy '"+name+"'")
		if !denied {
			failed = append(failed, fmt.Sprintf("%s: %v", name, err))
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("admission self-check failed: %s", strings.Join(failed, "; "))
	}
	return nil
}

// Frozen 读取 srenautix-freeze；ConfigMap 缺失或 frozen 不是 "false" 时为冻结。
func (e *Engine) Frozen(ctx context.Context) (bool, string, error) {
	cm, err := e.d.Kube.Core.CoreV1().ConfigMaps(e.cfg.Namespace).Get(ctx, "srenautix-freeze", metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return true, "srenautix-freeze is missing", nil
	}
	if err != nil {
		return true, "", err
	}
	v := cm.Data["frozen"]
	return v != "false", "frozen=" + v, nil
}

// gate 计算是否只提议：自检、熔断开关、审计汇、时钟偏差、apiserver 限流、策略加载。
// frozenOnly 表示冻结是唯一的原因：冻结只约束集群写入，此时 gitops_pr 仍然执行（ADR 0025）。
func (e *Engine) gate(ctx context.Context) (po bool, reasons []string, frozenOnly bool) {
	if err := e.reloadConfig(); err != nil {
		reasons = append(reasons, "policy: "+err.Error())
	}
	if err := e.periodicSelfCheck(ctx); err != nil {
		e.setCondition(metrics.ConditionAdmissionSelfCheck, false, "probe_allowed", err.Error())
		e.d.Metrics.SelfCheckOK.Set(0)
		reasons = append(reasons, err.Error())
	} else {
		e.setCondition(metrics.ConditionAdmissionSelfCheck, true, "probes_denied", "")
		e.d.Metrics.SelfCheckOK.Set(1)
	}
	frozen, detail, err := e.Frozen(ctx)
	if err != nil {
		detail = err.Error()
	}
	// Freeze 条件为 True 表示处于冻结
	e.setCondition(metrics.ConditionFreeze, frozen, map[bool]string{true: "frozen", false: "active"}[frozen], detail)
	e.d.Metrics.Frozen.Set(map[bool]float64{true: 1, false: 0}[frozen])
	if ok, aerr := e.d.Audit.Healthy(); !ok {
		e.setCondition(metrics.ConditionAuditSink, false, "sink_unavailable", fmt.Sprint(aerr))
		reasons = append(reasons, fmt.Sprintf("audit sink: %v", aerr))
	} else {
		e.setCondition(metrics.ConditionAuditSink, true, "writable", "")
	}
	skew, err := e.d.Kube.ClockSkew(ctx)
	if err != nil {
		e.setCondition(metrics.ConditionClockSkew, false, "unmeasured", err.Error())
		reasons = append(reasons, "clock skew: "+err.Error())
	} else {
		e.d.Metrics.ClockSkew.WithLabelValues("apiserver").Set(skew.Seconds())
		e.mu.Lock()
		e.lastSkew = skew
		e.mu.Unlock()
		if math.Abs(skew.Seconds()) > e.cfg.MaxClockSkew.Seconds() {
			e.setCondition(metrics.ConditionClockSkew, false, "too_large", skew.String())
			reasons = append(reasons, "clock skew "+skew.String())
		} else {
			e.setCondition(metrics.ConditionClockSkew, true, "within_limit", skew.String())
		}
	}
	if t := e.d.Kube.Throttle.Since(); !t.IsZero() && time.Since(t) < e.cfg.ThrottleHold {
		e.setCondition(metrics.ConditionApiserverThrottled, true, "http_429", t.UTC().Format(time.RFC3339))
		reasons = append(reasons, "apiserver returned 429")
	} else {
		e.setCondition(metrics.ConditionApiserverThrottled, false, "none", "")
	}
	e.probeGitBase(ctx)
	e.watchMain(ctx)
	frozenOnly = frozen && len(reasons) == 0
	if frozen {
		reasons = append(reasons, "srenautix-freeze: "+detail)
	}
	return len(reasons) > 0, reasons, frozenOnly
}

// safetyCheck 更新只提议状态并发送心跳。
func (e *Engine) safetyCheck(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	po, reasons, frozenOnly := e.gate(ctx)
	var accepts []string
	if _, ok := e.currentPolicy().Action(GitOnlyAction); ok && po && frozenOnly {
		accepts = []string{GitOnlyAction}
	}
	e.mu.Lock()
	e.proposeOnly = po
	e.accepts = accepts
	softPaused := e.softPaused
	e.mu.Unlock()
	e.d.Metrics.ProposeOnly.Set(map[bool]float64{true: 1, false: 0}[po])
	if po {
		slog.Warn("gateway is proposal-only", "reasons", reasons, "still_executing", accepts)
	}
	e.mu.Lock()
	skew := e.lastSkew
	e.mu.Unlock()
	hb := tunnel.Heartbeat{GatewayID: e.cfg.Identity, Version: e.cfg.Version, Leader: true, ProposeOnly: po, AcceptsActions: accepts,
		Conditions: e.Conditions(), Queue: e.q.snapshot(), ClockSkew: tunnel.ClockSkew{Apiserver: skew.Seconds()}}
	st, err := e.d.Hub.SendHeartbeat(ctx, hb)
	if err != nil {
		slog.Error("heartbeat", "err", err)
		return
	}
	e.observeHub(st.HubClock)
	if st.SoftPaused != softPaused {
		e.mu.Lock()
		e.softPaused = st.SoftPaused
		e.mu.Unlock()
	}
}
