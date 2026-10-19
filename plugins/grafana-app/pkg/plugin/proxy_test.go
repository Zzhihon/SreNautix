package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

func TestMatchAllowsReadsAndFeedbackOnly(t *testing.T) {
	const id = "3f2b8c1e-5d6a-4b7c-8d9e-0a1b2c3d4e5f"
	allowedCases := []struct{ method, path string }{
		{"GET", "/v1/incidents"},
		{"GET", "/v1/incidents/postgres.cluster:db%2Fpg-main:2026-10-19T06:10:00Z"},
		{"GET", "/v1/incidents/" + id + "/evidence"},
		{"GET", "/v1/incidents/" + id + "/timeline"},
		{"GET", "/v1/incidents/" + id + "/subgraph"},
		{"GET", "/v1/incidents/" + id + "/research"},
		{"POST", "/v1/incidents/" + id + "/feedback"},
		{"GET", "/v1/runs/" + id},
		{"GET", "/v1/runs/" + id + "/manifest"},
		{"GET", "/v1/proposals/" + id},
		{"GET", "/v1/conditions"},
	}
	for _, c := range allowedCases {
		if _, ok := match(c.method, c.path); !ok {
			t.Errorf("%s %s 应当放行", c.method, c.path)
		}
	}
	denied := []struct{ method, path string }{
		{"POST", "/v1/proposals/" + id + "/approve"},
		{"POST", "/v1/proposals/" + id + "/reject"},
		{"POST", "/v1/proposals/" + id + "/undo"},
		{"POST", "/v1/approvals/batch"},
		{"POST", "/v1/proposals"},
		{"POST", "/v1/incidents/" + id + "/research"},
		{"POST", "/v1/incidents/" + id + "/evidence/rerun"},
		{"GET", "/v1/runs/" + id + "/prompt/raw"},
		{"GET", "/v1/events"},
		{"PUT", "/v1/pause"},
		{"GET", "/v1/audit/records"},
		{"DELETE", "/v1/incidents/" + id + "/feedback"},
		{"GET", "/v1/incidents/" + id + "/feedback/../../proposals"},
	}
	for _, c := range denied {
		if _, ok := match(c.method, c.path); ok {
			t.Errorf("%s %s 不应放行", c.method, c.path)
		}
	}
}

func TestParseSettings(t *testing.T) {
	ok := backend.AppInstanceSettings{
		JSONData:                []byte(`{"hubUrl":"http://hub.example:8080","consoleUrl":"https://console.example"}`),
		DecryptedSecureJSONData: map[string]string{"hubToken": "tok"},
	}
	hub, token, err := ParseSettings(ok)
	if err != nil || hub.String() != "http://hub.example:8080" || token != "tok" {
		t.Fatalf("合法配置解析失败：%v %v %q", err, hub, token)
	}
	bad := []backend.AppInstanceSettings{
		{JSONData: []byte(`{}`), DecryptedSecureJSONData: map[string]string{"hubToken": "tok"}},
		{JSONData: []byte(`{"hubUrl":"hub.example"}`), DecryptedSecureJSONData: map[string]string{"hubToken": "tok"}},
		{JSONData: []byte(`{"hubUrl":"http://hub.example"}`)},
		{JSONData: []byte(`not json`)},
	}
	for i, s := range bad {
		if _, _, err := ParseSettings(s); err == nil {
			t.Errorf("第 %d 个不完整配置应当报错", i)
		}
	}
}

// 拒绝的路径在插件后端就地返回 403，不连接中心（中心地址指向一个不存在的端口）。
func TestDeniedPathNeverReachesHub(t *testing.T) {
	hub, err := url.Parse("http://127.0.0.1:9")
	if err != nil {
		t.Fatal(err)
	}
	p := &Proxy{Hub: hub, Token: "tok", Client: http.DefaultClient}
	req := httptest.NewRequest(http.MethodPost, "/v1/proposals/3f2b8c1e-5d6a-4b7c-8d9e-0a1b2c3d4e5f/approve", strings.NewReader("{}"))
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Login: "a", Email: "a@example.com"}))
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("状态码 %d，应为 403", rec.Code)
	}
	var body apiError
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Error != "not_proxied" {
		t.Fatalf("错误体 %s", rec.Body.String())
	}
}

// 没有邮箱的 Grafana 用户无法映射到中心的绑定用户，就地返回 401。
func TestUserWithoutEmailIsRejected(t *testing.T) {
	hub, err := url.Parse("http://127.0.0.1:9")
	if err != nil {
		t.Fatal(err)
	}
	p := &Proxy{Hub: hub, Token: "tok", Client: http.DefaultClient}
	req := httptest.NewRequest(http.MethodGet, "/v1/incidents", nil)
	req = req.WithContext(backend.WithUser(context.Background(), &backend.User{Login: "a"}))
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("状态码 %d，应为 401", rec.Code)
	}
}
