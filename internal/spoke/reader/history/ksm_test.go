package history_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/Zzhihon/SreNautix/internal/spoke/reader/history"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/query"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/testenv"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/topology"
)

var base = time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)

type series struct {
	labels   string
	from, to time.Duration // 存在区间 [from, to)
}

// ksmFixture 是 kube-state-metrics 的 2 小时历史：api-1 在 n1 上运行到 1h，之后同名 Pod（新 UID）在 n2 上于 1h10m 重建。
// 样本每 30 秒一个，相对整分钟偏移 7 秒，任何样本都不落在步长边界上。
var ksmFixture = []series{
	{`kube_node_info{node="n1"}`, 0, 2 * time.Hour},
	{`kube_node_info{node="n2"}`, 0, 2 * time.Hour},
	{`kube_pod_info{namespace="app",pod="api-1",uid="u1",node="n1",pod_ip="10.0.0.7",host_network="false"}`, 0, time.Hour},
	{`kube_pod_info{namespace="app",pod="api-1",uid="u2",node="n2",pod_ip="10.0.0.9",host_network="false"}`, 70 * time.Minute, 2 * time.Hour},
	{`kube_pod_info{namespace="kube-system",pod="proxy-n1",uid="p1",node="n1",pod_ip="10.0.0.7",host_network="true"}`, 0, 2 * time.Hour},
	// 静态 Pod 的 owner 是 Node：owner 节点是集群级的 Node:n1，不带 Pod 的命名空间
	{`kube_pod_owner{namespace="kube-system",pod="proxy-n1",uid="p1",owner_kind="Node",owner_name="n1",owner_is_controller="true"}`, 0, 2 * time.Hour},
	{`kube_pod_owner{namespace="app",pod="api-1",uid="u1",owner_kind="ReplicaSet",owner_name="api-rs",owner_is_controller="true"}`, 0, time.Hour},
	{`kube_pod_owner{namespace="app",pod="api-1",uid="u2",owner_kind="ReplicaSet",owner_name="api-rs",owner_is_controller="true"}`, 70 * time.Minute, 2 * time.Hour},
	{`kube_replicaset_owner{namespace="app",replicaset="api-rs",owner_kind="Deployment",owner_name="api",owner_is_controller="true"}`, 0, 2 * time.Hour},
	{`kube_pod_spec_volumes_persistentvolumeclaims_info{namespace="app",pod="api-1",uid="u1",volume="data",persistentvolumeclaim="api-data"}`, 0, time.Hour},
	{`kube_pod_spec_volumes_persistentvolumeclaims_info{namespace="app",pod="api-1",uid="u2",volume="data",persistentvolumeclaim="api-data"}`, 70 * time.Minute, 2 * time.Hour},
	{`kube_persistentvolumeclaim_info{namespace="app",persistentvolumeclaim="api-data",volumename="pv-1",storageclassname="csi"}`, 0, 2 * time.Hour},
	{`kube_persistentvolume_info{persistentvolume="pv-1",csi_driver="driver.example.io",storageclass="csi"}`, 0, 2 * time.Hour},
	{`kube_service_info{namespace="app",service="api",uid="s1",cluster_ip="10.96.0.10"}`, 0, 2 * time.Hour},
	// 标签值无法生成合法的组件键（命名空间不是 DNS 标签）：跳过并计数，其余序列照常重建
	{`kube_service_info{namespace="Not_A_Label",service="web",uid="s2",cluster_ip="10.96.0.11"}`, 0, 2 * time.Hour},
}

func render() (om, prom string) {
	var a, b strings.Builder
	metrics := map[string]bool{}
	for _, s := range ksmFixture {
		name := s.labels[:strings.Index(s.labels, "{")]
		if !metrics[name] {
			metrics[name] = true
			fmt.Fprintf(&a, "# TYPE %s gauge\n", name)
		}
		for t := s.from + 7*time.Second; t < s.to; t += 30 * time.Second {
			ts := base.Add(t)
			fmt.Fprintf(&a, "%s 1 %d\n", s.labels, ts.Unix())
			fmt.Fprintf(&b, "%s 1 %d\n", s.labels, ts.UnixMilli())
		}
	}
	// OpenMetrics 要求同一指标族的样本连续出现：按指标名重新排列
	lines := strings.Split(strings.TrimSpace(a.String()), "\n")
	byName := map[string][]string{}
	var order []string
	for _, l := range lines {
		var name string
		if strings.HasPrefix(l, "# TYPE ") {
			name = strings.Fields(l)[2]
		} else {
			name = l[:strings.Index(l, "{")]
		}
		if _, ok := byName[name]; !ok {
			order = append(order, name)
		}
		byName[name] = append(byName[name], l)
	}
	var out strings.Builder
	for _, n := range order {
		for _, l := range byName[n] {
			out.WriteString(l + "\n")
		}
	}
	out.WriteString("# EOF\n")
	return out.String(), b.String()
}

type view struct {
	Op       string
	Subject  string
	UID      string
	From, To string
}

func summarize(evs []topology.Event) []view {
	var out []view
	for _, e := range evs {
		v := view{Op: string(e.Op), From: e.ValidFrom.Sub(base).String(), To: "open"}
		if e.ValidTo != nil {
			v.To = e.ValidTo.Sub(base).String()
		}
		if e.Node != nil {
			v.Subject = e.Node.Key
			if e.Node.UID != nil {
				v.UID = *e.Node.UID
			}
		} else {
			v.Subject = e.Edge.ID()
		}
		out = append(out, v)
	}
	return out
}

func find(vs []view, subject string) []view {
	var out []view
	for _, v := range vs {
		if v.Subject == subject {
			out = append(out, v)
		}
	}
	return out
}

func TestRebuildFromKubeStateMetricsOnPrometheusAndVictoriaMetrics(t *testing.T) {
	om, pt := render()
	prom := testenv.StartPrometheus(t, testenv.BackfillPrometheus(t, om), "global:\n  scrape_interval: 30s\n")
	vm := testenv.StartVictoriaMetrics(t)
	testenv.ImportVictoriaMetrics(t, vm.URL, pt)
	exec, err := query.NewExecutor(query.DefaultLimits(), []query.Datasource{{Name: "prom", URL: prom.URL}, {Name: "vm", URL: vm.URL}}, nil, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	results := map[string]history.Result{}
	for _, ds := range []string{"prom", "vm"} {
		reg := prometheus.NewRegistry()
		rep := topology.NewReporter(reg, slog.New(slog.NewTextHandler(io.Discard, nil)))
		// 1 小时的分段：窗口跨两个分段，分段边界上的点只计一次
		rb, err := history.New(history.Config{Datasource: ds, Step: 5 * time.Minute, Chunk: time.Hour}, "c1", exec, rep)
		if err != nil {
			t.Fatal(err)
		}
		res := rb.Rebuild(ctx, history.Request{RequestID: "h", From: base.Add(2 * time.Minute), To: base.Add(2 * time.Hour)})
		if res.Status != "ok" {
			t.Fatalf("%s: %+v", ds, res.Error)
		}
		results[ds] = res
		vs := summarize(res.Events)
		if n := testutil.ToFloat64(rep.InvalidKeys().WithLabelValues("kube_service_info", "Service")); n == 0 {
			t.Fatalf("%s: the series with an invalid namespace was not counted", ds)
		}
		for _, v := range vs {
			if strings.Contains(v.Subject, "Not_A_Label") || v.UID == "s2" {
				t.Fatalf("%s: a node was rebuilt from an invalid key: %+v", ds, v)
			}
		}
		if svc := find(vs, "Service:app/api"); len(svc) != 1 {
			t.Fatalf("%s: valid service next to the invalid one: %+v", ds, svc)
		}

		if !res.From.Equal(base) {
			t.Fatalf("%s: window start not aligned to step: %s", ds, res.From)
		}
		if len(res.Missing) != 1 || res.Missing[0] != "kube_job_owner" {
			t.Fatalf("%s: missing metrics %v", ds, res.Missing)
		}
		pods := find(vs, "Pod:app/api-1")
		if len(pods) != 2 || pods[0].UID != "u1" || pods[0].From != "0s" || pods[0].To != "1h0m0s" ||
			pods[1].UID != "u2" || pods[1].From != "1h10m0s" || pods[1].To != "open" {
			t.Fatalf("%s: pod intervals %+v", ds, pods)
		}
		if on1 := find(vs, "Pod:app/api-1|runs_on|Node:n1"); len(on1) != 1 || on1[0].To != "1h0m0s" {
			t.Fatalf("%s: runs_on n1 %+v", ds, on1)
		}
		if on2 := find(vs, "Pod:app/api-1|runs_on|Node:n2"); len(on2) != 1 || on2[0].From != "1h10m0s" || on2[0].To != "open" {
			t.Fatalf("%s: runs_on n2 %+v", ds, on2)
		}
		// 两个 Pod 先后拥有同一条 owner 边：边有两个存在区间
		if own := find(vs, "Pod:app/api-1|owned_by|ReplicaSet:app/api-rs"); len(own) != 2 {
			t.Fatalf("%s: owner edge %+v", ds, own)
		}
		for _, id := range []string{
			"ReplicaSet:app/api-rs|owned_by|Deployment:app/api",
			"Pod:kube-system/proxy-n1|owned_by|Node:n1",
			"PersistentVolumeClaim:app/api-data|bound_to|PersistentVolume:pv-1",
			"PersistentVolume:pv-1|provisioned_by|CSIDriver:driver.example.io",
		} {
			if e := find(vs, id); len(e) != 1 || e[0].From != "0s" || e[0].To != "open" {
				t.Fatalf("%s: %s %+v", ds, id, e)
			}
		}
		for i, e := range res.Events {
			if e.Seq != int64(i)+1 || e.Source != topology.SourceKSMHistory || e.ClusterID != "c1" {
				t.Fatalf("%s: event %d: %+v", ds, i, e)
			}
		}

		// 按 IP 解析：hostNetwork Pod 共用节点 IP，不参与解析
		n, node, ok, err := rb.PodAt(ctx, "10.0.0.7", base.Add(30*time.Minute))
		if err != nil || !ok || n.Key != "Pod:app/api-1" || *n.UID != "u1" || node != "n1" {
			t.Fatalf("%s: PodAt 30m: %+v %s %v %v", ds, n, node, ok, err)
		}
		n, node, ok, _ = rb.PodAt(ctx, "10.0.0.9", base.Add(90*time.Minute))
		if !ok || *n.UID != "u2" || node != "n2" {
			t.Fatalf("%s: PodAt 90m: %+v %s %v", ds, n, node, ok)
		}
		if _, _, ok, _ = rb.PodAt(ctx, "10.0.0.9", base.Add(30*time.Minute)); ok {
			t.Fatalf("%s: PodAt resolved an IP before its pod existed", ds)
		}
	}

	// 两种后端的重建结果逐条一致，event_id 也相同（同一窗口重复重建可以去重）
	a, _ := json.Marshal(results["prom"].Events)
	b, _ := json.Marshal(results["vm"].Events)
	if string(a) != string(b) {
		t.Fatalf("Prometheus and VictoriaMetrics rebuilt different topology:\nprom=%v\nvm=%v", summarize(results["prom"].Events), summarize(results["vm"].Events))
	}

	rep := topology.NewReporter(prometheus.NewRegistry(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if _, err := history.New(history.Config{Datasource: "prom", Step: 7 * time.Minute, Chunk: time.Hour}, "c1", exec, rep); err == nil {
		t.Fatal("chunk that is not a multiple of step was accepted")
	}
	rb, err := history.New(history.Config{Datasource: "prom", Step: 5 * time.Minute, MaxWindow: time.Hour}, "c1", exec, rep)
	if err != nil {
		t.Fatal(err)
	}
	if res := rb.Rebuild(ctx, history.Request{From: base, To: base.Add(2 * time.Hour)}); res.Status != "error" || res.Error.Code != query.CodeBadRange {
		t.Fatalf("window over max: %+v", res)
	}
}
