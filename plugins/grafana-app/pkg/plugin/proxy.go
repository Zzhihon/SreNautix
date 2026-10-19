// Package plugin 是 SreNautix Grafana 应用插件的后端。它只代理中心 API 的只读接口与提交反馈，
// 用插件配置里的 Grafana 插件 token 调用中心，并在 X-SreNautix-On-Behalf-Of 中带上当前 Grafana 用户的邮箱；
// 中心把邮箱映射到已绑定的用户并按该用户的角色授权。审批、拒绝、撤销等写操作不经过插件，
// 插件页面里的"批准"打开控制台的审批页（DESIGN §12.5）。
package plugin

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// route 是放行的一条中心 API 路径：方法加路径模式。模式与 contract/openapi.yaml 的路径一一对应。
type route struct {
	method  string
	pattern *regexp.Regexp
	op      string
}

const (
	seg  = `[^/]+`
	uuid = `[0-9a-fA-F-]{36}`
)

func r(method, path, op string) route {
	return route{method: method, pattern: regexp.MustCompile(`^` + path + `$`), op: op}
}

// allowed 是插件后端放行的全部路径。查询参数原样转发，由中心校验。
var allowed = []route{
	r(http.MethodGet, `/v1/conditions`, "listConditions"),
	r(http.MethodGet, `/v1/clusters`, "listClusters"),
	r(http.MethodGet, `/v1/incidents`, "listIncidents"),
	r(http.MethodGet, `/v1/incidents/`+seg, "getIncident"),
	r(http.MethodGet, `/v1/incidents/`+seg+`/stage-a`, "getStageAReport"),
	r(http.MethodGet, `/v1/incidents/`+seg+`/evidence`, "getEvidenceSnapshot"),
	r(http.MethodGet, `/v1/incidents/`+seg+`/timeline`, "getIncidentTimeline"),
	r(http.MethodGet, `/v1/incidents/`+seg+`/subgraph`, "getIncidentSubgraph"),
	r(http.MethodGet, `/v1/incidents/`+seg+`/research`, "listResearchRuns"),
	r(http.MethodGet, `/v1/incidents/`+seg+`/feedback`, "listFeedback"),
	r(http.MethodPost, `/v1/incidents/`+seg+`/feedback`, "createFeedback"),
	r(http.MethodGet, `/v1/runs/`+uuid, "getResearchRun"),
	r(http.MethodGet, `/v1/runs/`+uuid+`/manifest`, "getResearchManifest"),
	r(http.MethodGet, `/v1/proposals`, "listProposals"),
	r(http.MethodGet, `/v1/proposals/`+uuid, "getProposal"),
}

// maxBody 是转发反馈请求体的上限（反馈的文本字段合计远小于这个值）。
const maxBody = 64 << 10

// Proxy 把资源调用转发到中心。
type Proxy struct {
	Hub    *url.URL
	Token  string
	Client *http.Client
}

type apiError struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	b, err := json.Marshal(apiError{Error: code, Message: msg})
	if err != nil {
		panic(err)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

func match(method, p string) (route, bool) {
	// 带 . 或 .. 段、重复斜杠的路径一律拒绝：转发前不做规范化，中心可能把它解析到放行列表之外
	if path.Clean(p) != p {
		return route{}, false
	}
	for _, rt := range allowed {
		if rt.method == method && rt.pattern.MatchString(p) {
			return rt, true
		}
	}
	return route{}, false
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	// 按转义后的路径匹配与转发：事件标签可能含有 %2F，解码后会多出一个路径段
	reqPath := "/" + strings.TrimPrefix(req.URL.EscapedPath(), "/")
	rt, ok := match(req.Method, reqPath)
	if !ok {
		writeError(w, http.StatusForbidden, "not_proxied",
			"Grafana 插件只代理中心的只读接口与提交反馈："+req.Method+" "+reqPath+"；审批请在 SreNautix 控制台中完成")
		return
	}
	user := backend.UserFromContext(req.Context())
	if user == nil || user.Email == "" {
		writeError(w, http.StatusUnauthorized, "no_user_email", "请求没有 Grafana 用户或用户没有邮箱，中心无法映射到已绑定的用户")
		return
	}
	target, err := url.Parse(strings.TrimSuffix(p.Hub.String(), "/") + reqPath)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_path", err.Error())
		return
	}
	target.RawQuery = req.URL.RawQuery
	var body io.Reader
	if req.Method == http.MethodPost {
		body = http.MaxBytesReader(w, req.Body, maxBody)
	}
	out, err := http.NewRequestWithContext(req.Context(), req.Method, target.String(), body)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "bad_upstream_request", err.Error())
		return
	}
	out.Header.Set("Authorization", "Bearer "+p.Token)
	out.Header.Set("X-SreNautix-On-Behalf-Of", user.Email)
	out.Header.Set("Accept", "application/json")
	if req.Method == http.MethodPost {
		out.Header.Set("Content-Type", "application/json")
	}
	resp, err := p.Client.Do(out)
	if err != nil {
		writeError(w, http.StatusBadGateway, "hub_unreachable", rt.op+": "+err.Error())
		return
	}
	defer resp.Body.Close()
	for _, h := range []string{"Content-Type", "X-Suppressed-Count"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}
