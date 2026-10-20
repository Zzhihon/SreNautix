// Package reader 是分支的只读角色（DESIGN §1.1、§18）：informer 拓扑、告警对账、声明式查询、kube-state-metrics 历史重建、
// 实体解析与 apiserver 时钟参考，全部经出站连接与中心交互。
package reader

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/Zzhihon/SreNautix/internal/spoke/reader/alerts"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/clock"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/health"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/history"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/hub"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/kube"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/query"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/topology"
	"github.com/Zzhihon/SreNautix/internal/spoke/tunnel"
)

// maxClockSkew 是 ClockSkew 条件的阈值（DESIGN §15.5：超过 2 秒告警）。
const maxClockSkew = 2 * time.Second

// Reader 是运行中的 reader。
type Reader struct {
	cfg      *Config
	version  string
	readerID string
	bootID   string
	log      *slog.Logger

	reg       *prometheus.Registry
	clock     *clock.APIServer
	watcher   *kube.Watcher
	store     *topology.Store
	exec      *query.Executor
	ksm       *history.Rebuilder
	recon     *alerts.Reconciler
	resolver  *Resolver
	hub       *hub.Client
	syncer    *hub.Syncer
	health    *health.Scanner
	unhealthy *prometheus.GaugeVec

	mu    sync.Mutex
	conds map[string]hub.Condition
	cond  *prometheus.GaugeVec
}

// Run 运行 reader 角色，直到 ctx 结束。
func Run(ctx context.Context, version string, args []string) error {
	fs := flag.NewFlagSet("reader", flag.ContinueOnError)
	cfgPath := fs.String("config", "/etc/srenautix/config.yaml", "reader 配置文件")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := LoadConfig(*cfgPath)
	if err != nil {
		return err
	}
	rc, err := restConfig(cfg.Kubeconfig)
	if err != nil {
		return err
	}
	readerID := os.Getenv("POD_NAME")
	if readerID == "" {
		readerID, err = os.Hostname()
		if err != nil {
			return err
		}
	}
	rd, err := New(cfg, rc, version, readerID, slog.New(slog.NewJSONHandler(os.Stderr, nil)))
	if err != nil {
		return err
	}
	return rd.Run(ctx)
}

func restConfig(kubeconfig string) (*rest.Config, error) {
	if kubeconfig == "" {
		return rest.InClusterConfig()
	}
	return clientcmd.BuildConfigFromFlags("", kubeconfig)
}

// New 按配置创建 reader 的全部组件，不启动任何循环。
func New(cfg *Config, rc *rest.Config, version, readerID string, log *slog.Logger) (*Reader, error) {
	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	rd := &Reader{cfg: cfg, version: version, readerID: readerID, bootID: uuid.NewString(), log: log, reg: reg, conds: map[string]hub.Condition{},
		cond: prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "srenautix_reader_condition", Help: "reader 状态条件（1 为 True，0 为 False 或 Unknown）。"}, []string{"type"})}
	reg.MustRegister(rd.cond)
	build := prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "srenautix_reader_build_info", Help: "reader 版本。"}, []string{"version"})
	reg.MustRegister(build)
	build.WithLabelValues(version).Set(1)

	httpc, err := rest.HTTPClientFor(rc)
	if err != nil {
		return nil, err
	}
	rd.clock = clock.New(httpc, rc.Host, reg)

	var manifest *query.Manifest
	if cfg.QueryManifest != "" {
		manifest, err = query.LoadManifest(cfg.QueryManifest)
		if err != nil {
			return nil, err
		}
	}
	rd.exec, err = query.NewExecutor(cfg.limits(), cfg.Datasources, manifest, reg)
	if err != nil {
		return nil, err
	}
	rep := topology.NewReporter(reg, log)
	rd.health = health.NewScanner()
	rd.health.Problems = func(ps []topology.Problem) { rep.Report("health", ps) }
	rd.unhealthy = prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "srenautix_reader_unhealthy_objects",
		Help: "最近一次上报中按状态计的不健康对象数（集群状态检测器）。"}, []string{"state"})
	reg.MustRegister(rd.unhealthy)
	if cfg.History != nil {
		h := cfg.History
		rd.ksm, err = history.New(history.Config{Datasource: h.Datasource, Matchers: h.Matchers, Step: time.Duration(h.Step), Chunk: time.Duration(h.Chunk),
			MaxSeries: h.MaxSeries, MaxBytes: h.MaxBytes, MaxWindow: time.Duration(h.MaxWindow)}, cfg.ClusterID, rd.exec, rep)
		if err != nil {
			return nil, err
		}
	}
	if cfg.Alerts != nil {
		ac := cfg.Alerts.Config
		if ac.MaxAlerts == 0 {
			ac.MaxAlerts = 10000
		}
		if ac.MaxBytes == 0 {
			ac.MaxBytes = 32 << 20
		}
		rd.recon, err = alerts.New(ac, cfg.ClusterID, rd.exec, rd.clock.Now, reg)
		if err != nil {
			return nil, err
		}
	}

	tc, err := tunnel.New(tunnel.Config{BaseURL: cfg.Hub.URL, Cluster: cfg.ClusterID, TokenFile: cfg.Hub.TokenFile, CAFile: cfg.Hub.CAFile,
		Timeout: orDefault(cfg.Hub.Timeout, 30*time.Second)})
	if err != nil {
		return nil, err
	}
	rd.hub = hub.NewClient(tc)
	rd.store = topology.NewStore(cfg.ClusterID)
	rd.syncer = hub.NewSyncer(rd.hub, rd.store, hub.Hello{ReaderID: readerID, Version: version, BootID: rd.bootID}, 5*time.Second,
		func(connected bool, err error) {
			if connected {
				rd.setCondition(hub.CondTunnelConnected, true, "Connected", "")
				return
			}
			rd.setCondition(hub.CondTunnelConnected, false, "Disconnected", err.Error())
			log.Warn("hub tunnel disconnected", "error", err)
		}, reg)

	cs, err := kubernetes.NewForConfig(rc)
	if err != nil {
		return nil, err
	}
	dyn, err := dynamic.NewForConfig(rc)
	if err != nil {
		return nil, err
	}
	disc, err := discovery.NewDiscoveryClientForConfig(rc)
	if err != nil {
		return nil, err
	}
	rd.watcher = kube.New(cs, &kube.CRDSource{Discovery: disc, Dynamic: dyn, Recognizers: topology.BuiltinRecognizers(), Every: orDefault(cfg.CRDRediscover, time.Minute)},
		rd.store, rd.clock, rd.syncer.Enqueue, reg, rep)
	rd.resolver = &Resolver{w: rd.watcher, ksm: rd.ksm}

	rd.setCondition(hub.CondTunnelConnected, false, "NotConnected", "")
	rd.setCondition(hub.CondInformersFresh, false, "Starting", "")
	if manifest != nil {
		rd.setCondition(hub.CondQueryManifest, true, "Loaded", fmt.Sprintf("%d templates, pack.lock %s", len(manifest.Queries), manifest.PackLock))
	} else {
		rd.setCondition(hub.CondQueryManifest, false, "NotMounted", "declared evidence queries are rejected")
	}
	return rd, nil
}

// Registry 返回 reader 的指标注册表。
func (rd *Reader) Registry() *prometheus.Registry { return rd.reg }

// Store 返回本地拓扑。
func (rd *Reader) Store() *topology.Store { return rd.store }

func (rd *Reader) setCondition(typ string, ok bool, reason, msg string) {
	status := "False"
	if ok {
		status = "True"
	}
	rd.mu.Lock()
	defer rd.mu.Unlock()
	prev, had := rd.conds[typ]
	since := time.Now().UTC()
	if had && prev.Status == status {
		since = prev.Since
	}
	rd.conds[typ] = hub.Condition{Type: typ, Status: status, Reason: reason, Message: msg, Since: since}
	v := 0.0
	if ok {
		v = 1
	}
	rd.cond.WithLabelValues(typ).Set(v)
}

// Conditions 返回当前全部状态条件，按类型排序。
func (rd *Reader) Conditions() []hub.Condition {
	rd.mu.Lock()
	defer rd.mu.Unlock()
	out := make([]hub.Condition, 0, len(rd.conds))
	for _, c := range rd.conds {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Type < out[j].Type })
	return out
}

func (rd *Reader) condition(typ string) hub.Condition {
	rd.mu.Lock()
	defer rd.mu.Unlock()
	return rd.conds[typ]
}

// Run 启动全部循环。informer 首次同步失败或 HTTP 监听失败时返回错误。
func (rd *Reader) Run(ctx context.Context) error {
	ln, err := net.Listen("tcp", rd.cfg.Listen)
	if err != nil {
		return err
	}
	return rd.Serve(ctx, ln)
}

// Serve 与 Run 相同，但使用给定的监听器。
func (rd *Reader) Serve(ctx context.Context, ln net.Listener) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	srv := &http.Server{Handler: rd.mux(), ReadHeaderTimeout: 10 * time.Second}
	srvErr := make(chan error, 1)
	go func() { srvErr <- srv.Serve(ln) }()
	defer srv.Close()

	if _, err := rd.clock.Measure(ctx); err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return fmt.Errorf("measure apiserver clock: %w", err)
	}
	rd.checkClock()
	if err := rd.watcher.Start(ctx); err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
	rd.refreshFresh()

	var wg sync.WaitGroup
	loop := func(f func()) {
		wg.Add(1)
		go func() { defer wg.Done(); f() }()
	}
	loop(func() { rd.syncer.Run(ctx) })
	loop(func() {
		rd.clock.Run(ctx, orDefault(rd.cfg.ClockInterval, time.Minute), func(err error) {
			rd.setCondition(hub.CondClockSkew, false, "MeasureFailed", err.Error())
		})
	})
	loop(func() { rd.heartbeatLoop(ctx) })
	loop(func() { rd.healthLoop(ctx) })
	loop(func() { rd.requestLoop(ctx) })
	if rd.recon != nil {
		loop(func() {
			rd.recon.Run(ctx, orDefault(rd.cfg.Alerts.Interval, 60*time.Second), func(s alerts.Snapshot) { rd.pushAlerts(ctx, s) })
		})
	}
	select {
	case <-ctx.Done():
	case err := <-srvErr:
		cancel()
		wg.Wait()
		return err
	}
	wg.Wait()
	return nil
}

func (rd *Reader) checkClock() {
	r, ok := rd.clock.Reading()
	if !ok {
		return
	}
	skew := r.Offset
	if skew < 0 {
		skew = -skew
	}
	if skew > maxClockSkew {
		rd.setCondition(hub.CondClockSkew, false, "SkewTooLarge", fmt.Sprintf("local clock differs from apiserver by %s (±%s)", r.Offset, r.Uncertainty))
		return
	}
	rd.setCondition(hub.CondClockSkew, true, "WithinLimit", fmt.Sprintf("offset %s ±%s", r.Offset, r.Uncertainty))
}

func (rd *Reader) refreshFresh() {
	ok, msg := rd.watcher.Fresh()
	reason := "Synced"
	if !ok {
		reason = "Stale"
	}
	rd.setCondition(hub.CondInformersFresh, ok, reason, msg)
}

func (rd *Reader) heartbeat() hub.Heartbeat {
	rd.refreshFresh()
	rd.checkClock()
	r, _ := rd.clock.Reading()
	hb := hub.Heartbeat{ReaderID: rd.readerID, Version: rd.version, BootID: rd.bootID, TopologySeq: rd.store.Seq(), Conditions: rd.Conditions(),
		Clock: hub.ClockReport{APIServerTime: rd.clock.Now(), Offset: r.Offset.Seconds(), Uncertainty: r.Uncertainty.Seconds(), MeasuredAt: r.MeasuredAt}}
	if m := rd.exec.Manifest(); m != nil {
		hb.QueryManifest = &hub.ManifestReport{PackLock: m.PackLock, Templates: len(m.Queries)}
	}
	return hb
}

// HealthReport 判定当前不健康的对象。informer 不新鲜时 complete 为 false，中心不据此清除已有的发现（ADR 0035）。
func (rd *Reader) HealthReport() health.Report {
	objs, complete := rd.health.Scan(rd.watcher, rd.clock.Now())
	if ok, _ := rd.watcher.Fresh(); !ok {
		complete = false
	}
	counts := map[string]int{}
	for _, o := range objs {
		counts[o.State]++
	}
	for _, s := range []string{health.PodPending, health.PodInit, health.CrashLoop, health.RolloutStalled, health.PDBBlocking, health.JobFailed} {
		rd.unhealthy.WithLabelValues(s).Set(float64(counts[s]))
	}
	return health.Report{ReaderID: rd.readerID, ObservedAt: rd.clock.Now().UTC(), Complete: complete, Objects: objs}
}

func (rd *Reader) healthLoop(ctx context.Context) {
	t := time.NewTicker(orDefault(rd.cfg.HealthInterval, 30*time.Second))
	defer t.Stop()
	for {
		if err := rd.hub.PushHealth(ctx, rd.HealthReport()); err != nil && ctx.Err() == nil {
			rd.syncer.Errors().WithLabelValues("health").Inc()
			rd.log.Warn("push object health failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (rd *Reader) heartbeatLoop(ctx context.Context) {
	t := time.NewTicker(orDefault(rd.cfg.HeartbeatInterval, 15*time.Second))
	defer t.Stop()
	for {
		if _, err := rd.hub.SendHeartbeat(ctx, rd.heartbeat()); err != nil && ctx.Err() == nil {
			rd.syncer.Errors().WithLabelValues("heartbeat").Inc()
			rd.syncer.Broken(fmt.Errorf("heartbeat: %w", err))
			rd.log.Warn("heartbeat failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (rd *Reader) pushAlerts(ctx context.Context, s alerts.Snapshot) {
	failed := []string{}
	if s.Alertmanager != nil && s.Alertmanager.Status != "ok" {
		failed = append(failed, "alertmanager: "+s.Alertmanager.Error)
	}
	if s.Rules != nil && s.Rules.Status != "ok" {
		failed = append(failed, "rules: "+s.Rules.Error)
	}
	if len(failed) == 0 {
		rd.setCondition(hub.CondAlertReconcile, true, "Read", "")
	} else {
		rd.setCondition(hub.CondAlertReconcile, false, "ReadFailed", fmt.Sprint(failed))
	}
	if _, err := rd.hub.PushAlerts(ctx, s); err != nil && ctx.Err() == nil {
		rd.syncer.Errors().WithLabelValues("alerts").Inc()
		rd.log.Warn("push alert reconcile snapshot failed", "error", err)
	}
}

// requestLoop 长轮询领取读取请求，用有限的并发执行，结果按 request_id 幂等回传；回传失败时重试，直到成功或 ctx 结束。
func (rd *Reader) requestLoop(ctx context.Context) {
	workers := rd.cfg.RequestWorkers
	if workers <= 0 {
		workers = 16
	}
	sem := make(chan struct{}, workers)
	var wg sync.WaitGroup
	defer wg.Wait()
	for ctx.Err() == nil {
		batch, err := rd.hub.PullRequests(ctx, 30*time.Second, workers)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			rd.syncer.Errors().WithLabelValues("requests").Inc()
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Second):
			}
			continue
		}
		for _, req := range batch.Requests {
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			wg.Add(1)
			go func(req hub.Request) {
				defer wg.Done()
				defer func() { <-sem }()
				res := rd.handle(ctx, req)
				for ctx.Err() == nil {
					_, err := rd.hub.PushResults(ctx, hub.ResultBatch{Results: []hub.Result{res}})
					if err == nil {
						return
					}
					var he *tunnel.HTTPError
					if errors.As(err, &he) && he.Status >= 400 && he.Status < 500 {
						rd.log.Error("hub rejected a reader result", "request_id", req.RequestID, "error", err)
						return
					}
					rd.syncer.Errors().WithLabelValues("results").Inc()
					select {
					case <-ctx.Done():
					case <-time.After(2 * time.Second):
					}
				}
			}(req)
		}
	}
}

func (rd *Reader) mux() *http.ServeMux {
	m := http.NewServeMux()
	m.Handle("GET /metrics", promhttp.HandlerFor(rd.reg, promhttp.HandlerOpts{}))
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	// 就绪只取决于 informer 新鲜度：中心不可达时 reader 仍然要保留本地状态并持续重连，不能因此被重启
	m.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		rd.refreshFresh()
		c := rd.condition(hub.CondInformersFresh)
		if c.Status != "True" {
			http.Error(w, c.Message, http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	return m
}
