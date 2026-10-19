package testenv

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

// AuditEvent 是 kube-apiserver 审计日志（audit.k8s.io/v1 Event）中测试关心的字段。
type AuditEvent struct {
	Stage            string                    `json:"stage"`
	Verb             string                    `json:"verb"`
	RequestURI       string                    `json:"requestURI"`
	User             struct{ Username string } `json:"user"`
	ImpersonatedUser *struct {
		Username string `json:"username"`
	} `json:"impersonatedUser"`
	ObjectRef *struct {
		Resource    string `json:"resource"`
		Namespace   string `json:"namespace"`
		Name        string `json:"name"`
		APIGroup    string `json:"apiGroup"`
		Subresource string `json:"subresource"`
	} `json:"objectRef"`
	ResponseStatus *struct {
		Code int `json:"code"`
	} `json:"responseStatus"`
}

// Username 返回实际生效的用户（模拟身份优先）。
func (e AuditEvent) Username() string {
	if e.ImpersonatedUser != nil && e.ImpersonatedUser.Username != "" {
		return e.ImpersonatedUser.Username
	}
	return e.User.Username
}

// DryRun 表示请求带 dryRun。
func (e AuditEvent) DryRun() bool { return bytes.Contains([]byte(e.RequestURI), []byte("dryRun=")) }

// Succeeded 表示请求完成且返回 2xx。
func (e AuditEvent) Succeeded() bool {
	return e.Stage == "ResponseComplete" && e.ResponseStatus != nil && e.ResponseStatus.Code >= 200 && e.ResponseStatus.Code < 300
}

// AuditEvents 读取 apiserver 审计日志中已完成的事件。
func (e *Env) AuditEvents(t testing.TB) []AuditEvent {
	t.Helper()
	if e.AuditLog == "" {
		t.Fatal("the apiserver was started without an audit log")
	}
	f, err := os.Open(e.AuditLog)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []AuditEvent
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for sc.Scan() {
		var ev AuditEvent
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
			t.Fatal(err)
		}
		if ev.Stage == "ResponseComplete" {
			out = append(out, ev)
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// GatewayWrites 返回 gateway 身份成功完成的、非 dryRun 的写请求，排除它自己的记录（ActionExecution、Lease、Event）。
func (e *Env) GatewayWrites(t testing.TB) []AuditEvent {
	t.Helper()
	var out []AuditEvent
	for _, ev := range e.AuditEvents(t) {
		if ev.Username() != GatewayUser || !ev.Succeeded() || ev.DryRun() || ev.ObjectRef == nil {
			continue
		}
		switch ev.Verb {
		case "create", "update", "patch", "delete", "deletecollection":
		default:
			continue
		}
		switch ev.ObjectRef.Resource {
		case "actionexecutions", "leases", "events", "selfsubjectaccessreviews", "selfsubjectrulesreviews":
			continue
		}
		out = append(out, ev)
	}
	return out
}
