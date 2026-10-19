package alerts_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/Zzhihon/SreNautix/internal/spoke/reader/alerts"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/query"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/testenv"
)

const rules = `groups:
  - name: test
    interval: 1s
    rules:
      - alert: ReaderTestFiring
        expr: vector(1)
        for: 2s
        labels:
          severity: warning
          source: %s
      - alert: ReaderTestPending
        expr: vector(1)
        for: 1h
        labels:
          severity: info
          source: %s
`

func findRule(p *alerts.Part[alerts.RuleAlert], name string) (alerts.RuleAlert, bool) {
	for _, a := range p.Items {
		if a.Labels["alertname"] == name {
			return a, true
		}
	}
	return alerts.RuleAlert{}, false
}

func TestReconcileSnapshotFromAlertmanagerAndAlertsSeries(t *testing.T) {
	am := testenv.StartAlertmanager(t)

	// Prometheus：规则在本地求值，ALERTS 写入自己的 TSDB，告警发往 Alertmanager
	dir := testenv.Scratch(t, "prom-rules")
	ruleFile := dir + "/rules.yml"
	writeFile(t, ruleFile, fmt.Sprintf(rules, "prometheus", "prometheus"))
	prom := testenv.StartPrometheus(t, testenv.Scratch(t, "prom-tsdb"), fmt.Sprintf(`global:
  scrape_interval: 1s
  evaluation_interval: 1s
rule_files: [%q]
alerting:
  alertmanagers:
    - static_configs:
        - targets: [%q]
`, ruleFile, am.URL[len("http://"):]))

	// VictoriaMetrics + vmalert：ALERTS 经 remote write 写回 VictoriaMetrics
	vm := testenv.StartVictoriaMetrics(t)
	testenv.StartVMAlert(t, vm.URL, am.URL, fmt.Sprintf(rules, "vmalert", "vmalert"))

	exec, err := query.NewExecutor(query.DefaultLimits(), []query.Datasource{{Name: "prom", URL: prom.URL}, {Name: "vm", URL: vm.URL}}, nil, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for _, ds := range []string{"prom", "vm"} {
		rc, err := alerts.New(alerts.Config{AlertmanagerURL: am.URL, MetricsDatasource: ds, MaxAlerts: 100, MaxBytes: 1 << 20}, "c1", exec,
			func() time.Time { return time.Now() }, prometheus.NewRegistry())
		if err != nil {
			t.Fatal(err)
		}
		testenv.Eventually(t, 60*time.Second, func() error {
			s := rc.Snapshot(ctx)
			if s.ClusterID != "c1" || s.Alertmanager == nil || s.Rules == nil {
				return fmt.Errorf("snapshot parts missing: %+v", s)
			}
			if s.Alertmanager.Status != "ok" || s.Rules.Status != "ok" {
				return fmt.Errorf("status am=%s (%s) rules=%s (%s)", s.Alertmanager.Status, s.Alertmanager.Error, s.Rules.Status, s.Rules.Error)
			}
			src := map[string]string{"prom": "prometheus", "vm": "vmalert"}[ds]
			var amHit bool
			for _, a := range s.Alertmanager.Items {
				if a.Labels["alertname"] == "ReaderTestFiring" && a.Labels["source"] == src && a.Status.State == "active" && !a.StartsAt.IsZero() {
					amHit = true
				}
			}
			if !amHit {
				return fmt.Errorf("%s: firing alert not in Alertmanager yet (%d items)", ds, len(s.Alertmanager.Items))
			}
			firing, ok := findRule(s.Rules, "ReaderTestFiring")
			if !ok || firing.State != "firing" || firing.ActiveAt == nil || firing.Labels["source"] != src {
				return fmt.Errorf("%s: firing rule alert %+v", ds, firing)
			}
			if _, has := firing.Labels["alertstate"]; has {
				return fmt.Errorf("%s: alertstate label kept", ds)
			}
			pending, ok := findRule(s.Rules, "ReaderTestPending")
			if !ok || pending.State != "pending" || pending.ActiveAt == nil {
				return fmt.Errorf("%s: pending rule alert %+v", ds, pending)
			}
			if time.Since(*firing.ActiveAt) > 5*time.Minute || firing.ActiveAt.After(time.Now()) {
				return fmt.Errorf("%s: active_at %s implausible", ds, firing.ActiveAt)
			}
			return nil
		})
	}

	// Alertmanager 不可达时，对应部分报告错误，中心不会据此判断告警已消失；截断同样标注
	down := fmt.Sprintf("http://127.0.0.1:%d", testenv.FreePort(t))
	rc, err := alerts.New(alerts.Config{AlertmanagerURL: down, MetricsDatasource: "prom", MaxAlerts: 1, MaxBytes: 1 << 20}, "c1", exec, time.Now, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	s := rc.Snapshot(ctx)
	if s.Alertmanager.Status != "error" || s.Alertmanager.Error == "" || len(s.Alertmanager.Items) != 0 {
		t.Fatalf("unreachable alertmanager: %+v", s.Alertmanager)
	}
	if s.Rules.Status != "ok" || !s.Rules.Truncated || len(s.Rules.Items) != 1 {
		t.Fatalf("truncated rules part: %+v", s.Rules)
	}
}
