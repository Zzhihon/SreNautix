package reader_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
	"sigs.k8s.io/yaml"

	"github.com/Zzhihon/SreNautix/internal/spoke/reader"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/hub/hubtest"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/query"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/testenv"
)

var base = time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Hour)

func writeFile(t *testing.T, path string, b []byte) {
	t.Helper()
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

// kubeconfigFor 把 envtest 的 rest.Config 写成 kubeconfig 文件，reader 按正式部署的方式从配置文件读取。
func kubeconfigFor(t *testing.T, cfg *rest.Config, path string) {
	t.Helper()
	kc := clientcmdapi.NewConfig()
	kc.Clusters["envtest"] = &clientcmdapi.Cluster{Server: cfg.Host, CertificateAuthorityData: cfg.CAData}
	kc.AuthInfos["envtest"] = &clientcmdapi.AuthInfo{ClientCertificateData: cfg.CertData, ClientKeyData: cfg.KeyData, Token: cfg.BearerToken}
	kc.Contexts["envtest"] = &clientcmdapi.Context{Cluster: "envtest", AuthInfo: "envtest"}
	kc.CurrentContext = "envtest"
	if err := clientcmd.WriteToFile(*kc, path); err != nil {
		t.Fatal(err)
	}
}

// ksm 生成最近 2 小时的 kube_pod_info 历史，供历史重建与按 IP 解析使用。
func ksm() string {
	var b strings.Builder
	b.WriteString("# TYPE kube_pod_info gauge\n")
	for t := 7 * time.Second; t < 2*time.Hour; t += 30 * time.Second {
		fmt.Fprintf(&b, "kube_pod_info{namespace=\"app\",pod=\"old-1\",uid=\"o1\",node=\"n1\",pod_ip=\"10.9.0.1\",host_network=\"false\"} 1 %d\n", base.Add(t).Unix())
	}
	b.WriteString("# EOF\n")
	return b.String()
}

func manifestFile(t *testing.T, path string) string {
	t.Helper()
	tpl := query.Template{ID: "pod/info", Dialect: query.DialectPromQL, Expr: `kube_pod_info{namespace="$namespace"}`,
		Params: map[string]query.Param{"namespace": {Type: query.ParamLabelValue}}}
	tpl.ContentHash = query.ContentHash(tpl)
	b, err := yaml.Marshal(map[string]any{"version": 1, "pack_lock": "sha256:" + strings.Repeat("cd", 32), "queries": []query.Template{tpl}})
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, path, b)
	return tpl.ContentHash
}

type readerSnapshot struct {
	nodes, edges map[string]string
}

func readerTopology(t *testing.T, rd *reader.Reader) readerSnapshot {
	t.Helper()
	snap := rd.Store().Snapshot(time.Now())
	out := readerSnapshot{nodes: map[string]string{}, edges: map[string]string{}}
	for _, n := range snap.Nodes {
		b, _ := json.Marshal(n.Node)
		out.nodes[n.Node.Key] = canonical(b)
	}
	for _, e := range snap.Edges {
		b, _ := json.Marshal(e.Edge)
		out.edges[e.Edge.ID()] = canonical(b)
	}
	return out
}

func canonical(b []byte) string {
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		panic(err)
	}
	c, _ := json.Marshal(v)
	return string(c)
}

func converged(t *testing.T, rd *reader.Reader, h *hubtest.Server) func() error {
	return func() error {
		r := readerTopology(t, rd)
		hn, he := h.Topology()
		if len(r.nodes) != len(hn) || len(r.edges) != len(he) {
			return fmt.Errorf("reader %d nodes / %d edges, hub %d / %d", len(r.nodes), len(r.edges), len(hn), len(he))
		}
		for k, v := range r.nodes {
			if hn[k] != v {
				return fmt.Errorf("node %s: reader %s, hub %s", k, v, hn[k])
			}
		}
		for k, v := range r.edges {
			if he[k] != v {
				return fmt.Errorf("edge %s differs", k)
			}
		}
		if h.Stats().TopologySeq != rd.Store().Seq() {
			return fmt.Errorf("hub topology_seq %d, reader %d", h.Stats().TopologySeq, rd.Store().Seq())
		}
		return nil
	}
}

func get(t *testing.T, url string) (int, string) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func conditionStatus(hb map[string]any, typ string) string {
	for _, c := range hb["conditions"].([]any) {
		m := c.(map[string]any)
		if m["type"] == typ {
			return m["status"].(string)
		}
	}
	return ""
}

func pod(ns, name, node string) *corev1.Pod {
	return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name},
		Spec: corev1.PodSpec{NodeName: node, Containers: []corev1.Container{{Name: "c", Image: "x"}}}}
}

func TestReaderEndToEndThroughTheTunnel(t *testing.T) {
	kcfg, _ := testenv.StartKube(t, true)
	cs := kubernetes.NewForConfigOrDie(kcfg)
	c := context.Background()
	for _, ns := range []string{"app", "db"} {
		if _, err := cs.CoreV1().Namespaces().Create(c, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}}, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := cs.CoreV1().Nodes().Create(c, &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "n1"}}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	p, err := cs.CoreV1().Pods("app").Create(c, pod("app", "api-1", "n1"), metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	p.Status.PodIP = "10.0.0.7"
	if _, err := cs.CoreV1().Pods("app").UpdateStatus(c, p, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}

	prom := testenv.StartPrometheus(t, testenv.BackfillPrometheus(t, ksm()), "global:\n  scrape_interval: 30s\n")
	am := testenv.StartAlertmanager(t)
	h := hubtest.Start(t, "edge-1", "s3cret")

	dir := testenv.Scratch(t, "reader")
	writeFile(t, filepath.Join(dir, "token"), []byte("s3cret\n"))
	kubeconfigFor(t, kcfg, filepath.Join(dir, "kubeconfig"))
	hash := manifestFile(t, filepath.Join(dir, "queries.yaml"))
	cfgYAML := fmt.Sprintf(`cluster_id: edge-1
listen: 127.0.0.1:0
kubeconfig: %s
hub:
  url: %s
  token_file: %s
  timeout: 10s
datasources:
  - name: metrics
    url: %s
query_manifest: %s
alerts:
  alertmanager_url: %s
  metrics_datasource: metrics
  interval: 1s
history:
  datasource: metrics
  step: 5m
crd_rediscover: 1s
clock_interval: 2s
heartbeat_interval: 1s
`, filepath.Join(dir, "kubeconfig"), h.URL(), filepath.Join(dir, "token"), prom.URL, filepath.Join(dir, "queries.yaml"), am.URL)
	writeFile(t, filepath.Join(dir, "config.yaml"), []byte(cfgYAML))
	cfg, err := reader.LoadConfig(filepath.Join(dir, "config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	restCfg, err := clientcmd.BuildConfigFromFlags("", cfg.Kubeconfig)
	if err != nil {
		t.Fatal(err)
	}
	rd, err := reader.New(cfg, restCfg, "test", "reader-0", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- rd.Serve(ctx, ln) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("reader exited with %v", err)
		}
		if v := h.Violations(); len(v) > 0 {
			t.Errorf("contract violations:\n%s", strings.Join(v, "\n"))
		}
	})
	local := "http://" + ln.Addr().String()

	// 首次连接：informer 同步后，快照让中心与 reader 的拓扑一致
	testenv.Eventually(t, 30*time.Second, func() error {
		if code, body := get(t, local+"/readyz"); code != http.StatusOK {
			return fmt.Errorf("readyz %d %s", code, body)
		}
		if h.Stats().Snapshots == 0 {
			return fmt.Errorf("no snapshot yet")
		}
		return converged(t, rd, h)()
	})
	if _, he := h.Topology(); he["Pod:app/api-1|runs_on|Node:n1"] == "" {
		t.Fatalf("hub topology lacks pod edge: %v", hubtest.SortedKeys(he))
	}

	// 增量事件
	if _, err := cs.CoreV1().Pods("app").Create(c, pod("app", "api-2", "n1"), metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	testenv.Eventually(t, 15*time.Second, func() error {
		if _, he := h.Topology(); he["Pod:app/api-2|runs_on|Node:n1"] == "" {
			return fmt.Errorf("api-2 not on hub yet")
		}
		return converged(t, rd, h)()
	})
	snapshots := h.Stats().Snapshots

	// 响应在途中丢失：中心已应用但返回 503，reader 重试同一批事件，中心按 event_id 去重
	h.FailAfterApply(1)
	if _, err := cs.CoreV1().Pods("app").Create(c, pod("app", "api-3", "n1"), metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	testenv.Eventually(t, 30*time.Second, func() error {
		if _, he := h.Topology(); he["Pod:app/api-3|runs_on|Node:n1"] == "" {
			return fmt.Errorf("api-3 not on hub yet")
		}
		// 重试后的会话以快照开始，快照覆盖已应用的事件；中心状态不因重试改变
		if s := h.Stats(); s.Hellos < 2 || s.Snapshots == snapshots {
			return fmt.Errorf("reader has not retried after the lost response: %+v", s)
		}
		return converged(t, rd, h)()
	})

	// 中心不可达：reader 报告断开，期间的变化在恢复后补齐
	h.SetDown(true)
	testenv.Eventually(t, 30*time.Second, func() error {
		_, body := get(t, local+"/metrics")
		if !strings.Contains(body, "srenautix_reader_tunnel_connected 0") {
			return fmt.Errorf("tunnel still reported connected")
		}
		return nil
	})
	// envtest 没有 kubelet：已绑定节点的 Pod 只有宽限期为 0 时才会立即删除
	zero := int64(0)
	if err := cs.CoreV1().Pods("app").Delete(c, "api-2", metav1.DeleteOptions{GracePeriodSeconds: &zero}); err != nil {
		t.Fatal(err)
	}
	if code, _ := get(t, local+"/readyz"); code != http.StatusOK {
		t.Fatalf("reader must stay ready while the hub is down: %d", code)
	}
	time.Sleep(2 * time.Second)
	h.SetDown(false)
	testenv.Eventually(t, 30*time.Second, func() error {
		if _, he := h.Topology(); he["Pod:app/api-2|runs_on|Node:n1"] != "" {
			return fmt.Errorf("api-2 deletion not on hub yet")
		}
		return converged(t, rd, h)()
	})

	// 中心丢失拓扑状态：下一次推送收到 resync_required，reader 重新上传快照
	before := h.Stats().Snapshots
	h.Reset()
	if _, err := cs.CoreV1().Pods("db").Create(c, pod("db", "pg-1", "n1"), metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	testenv.Eventually(t, 30*time.Second, func() error {
		if h.Stats().Snapshots == before {
			return fmt.Errorf("no resync after hub reset")
		}
		return converged(t, rd, h)()
	})

	// 读取请求：声明式查询、实体解析（informer 与 kube-state-metrics 历史）、历史重建、未声明的模板
	deadline := time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	reqs := map[string]hubtest.Request{
		"query": {"request_id": uuid.NewString(), "kind": "query", "deadline": deadline, "query": map[string]any{
			"datasource": "metrics", "template_id": "pod/info", "content_hash": hash, "params": map[string]any{"namespace": "app"},
			"time": base.Add(time.Hour).Format(time.RFC3339)}},
		"undeclared": {"request_id": uuid.NewString(), "kind": "query", "deadline": deadline, "query": map[string]any{
			"datasource": "metrics", "template_id": "raw/promql", "content_hash": hash, "params": map[string]any{},
			"time": base.Add(time.Hour).Format(time.RFC3339)}},
		"resolve-live": {"request_id": uuid.NewString(), "kind": "resolve", "deadline": deadline, "resolve": map[string]any{
			"pod_ip": "10.0.0.7", "at": time.Now().UTC().Format(time.RFC3339)}},
		"resolve-history": {"request_id": uuid.NewString(), "kind": "resolve", "deadline": deadline, "resolve": map[string]any{
			"pod_ip": "10.9.0.1", "at": base.Add(time.Hour).Format(time.RFC3339)}},
		"history": {"request_id": uuid.NewString(), "kind": "ksm_history", "deadline": deadline, "history": map[string]any{
			"from": base.Format(time.RFC3339), "to": base.Add(2 * time.Hour).Format(time.RFC3339)}},
	}
	h.FailAfterApply(1) // 第一个结果的确认丢失：reader 重试，中心记为重复
	for _, r := range reqs {
		h.Enqueue(r)
	}
	res := map[string]map[string]any{}
	for name, r := range reqs {
		out, ok := h.Result(r["request_id"].(string), 60*time.Second)
		if !ok {
			t.Fatalf("no result for %s", name)
		}
		res[name] = out
	}
	q := res["query"]["query"].(map[string]any)
	if q["status"] != "ok" || len(q["series"].([]any)) != 1 || !strings.Contains(q["rendered"].(string), `namespace="app"`) {
		t.Fatalf("query result: %v", q)
	}
	if e := res["undeclared"]["query"].(map[string]any)["error"].(map[string]any); e["error"] != query.CodeUndeclared {
		t.Fatalf("undeclared template: %v", e)
	}
	live := res["resolve-live"]["resolve"].(map[string]any)
	if live["layer"] != "informer" || live["node"].(map[string]any)["key"] != "Pod:app/api-1" || live["node_name"] != "n1" {
		t.Fatalf("resolve live: %v", live)
	}
	old := res["resolve-history"]["resolve"].(map[string]any)
	if old["layer"] != "ksm_history" || old["node"].(map[string]any)["key"] != "Pod:app/old-1" {
		t.Fatalf("resolve history: %v", old)
	}
	hist := res["history"]["history"].(map[string]any)
	if hist["status"] != "ok" || len(hist["events"].([]any)) == 0 {
		t.Fatalf("history: %v", hist)
	}
	testenv.Eventually(t, 10*time.Second, func() error {
		if h.Stats().DupResults == 0 {
			return fmt.Errorf("lost result acknowledgement was not retried")
		}
		return nil
	})

	// 心跳：条件、apiserver 时钟参考、拓扑序号；告警对账；本地指标与就绪
	testenv.Eventually(t, 15*time.Second, func() error {
		hb := h.LastHeartbeat()
		if hb == nil {
			return fmt.Errorf("no heartbeat")
		}
		for _, typ := range []string{"InformersFresh", "TunnelConnected", "ClockSkew", "QueryManifest", "AlertReconcile"} {
			if st := conditionStatus(hb, typ); st != "True" {
				return fmt.Errorf("condition %s = %q", typ, st)
			}
		}
		clk := hb["clock"].(map[string]any)
		at, err := time.Parse(time.RFC3339Nano, clk["apiserver_time"].(string))
		if err != nil || time.Since(at).Abs() > 5*time.Second {
			return fmt.Errorf("apiserver_time %v", clk["apiserver_time"])
		}
		if hb["query_manifest"].(map[string]any)["templates"].(json.Number).String() != "1" {
			return fmt.Errorf("manifest report %v", hb["query_manifest"])
		}
		al := h.LastAlerts()
		if al == nil || al["alertmanager"].(map[string]any)["status"] != "ok" || al["rules"].(map[string]any)["status"] != "ok" {
			return fmt.Errorf("alert snapshot %v", al)
		}
		return nil
	})
	code, body := get(t, local+"/metrics")
	for _, m := range []string{
		"srenautix_reader_informer_synced{resource=\"pods\"} 1",
		"srenautix_reader_tunnel_connected 1",
		"srenautix_reader_condition{type=\"InformersFresh\"} 1",
		"srenautix_reader_topology_resyncs_total",
		"srenautix_reader_query_requests_total{datasource=\"metrics\",origin=\"declared\",result=\"ok\"}",
		"srenautix_clock_skew_seconds{peer=\"apiserver\"}",
		"srenautix_reader_alert_reconcile_total",
	} {
		if code != http.StatusOK || !strings.Contains(body, m) {
			t.Fatalf("metric %s missing", m)
		}
	}
	if code, _ := get(t, local+"/readyz"); code != http.StatusOK {
		t.Fatalf("readyz %d", code)
	}
}
