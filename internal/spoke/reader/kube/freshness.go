package kube

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"k8s.io/client-go/tools/cache"
)

type metrics struct {
	synced      *prometheus.GaugeVec
	lastEvent   *prometheus.GaugeVec
	lastRV      *prometheus.GaugeVec
	watchErrors *prometheus.CounterVec
	events      *prometheus.CounterVec
	nodes       prometheus.Gauge
	edges       prometheus.Gauge
	tombstones  prometheus.Gauge
}

func newMetrics(reg prometheus.Registerer) *metrics {
	m := &metrics{
		synced: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "srenautix_reader_informer_synced", Help: "informer 是否已完成首次同步（1 是，0 否）。"}, []string{"resource"}),
		lastEvent: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "srenautix_reader_informer_last_event_timestamp_seconds", Help: "informer 最近一次收到对象变化的时间。"}, []string{"resource"}),
		lastRV: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "srenautix_reader_informer_last_resource_version_change_timestamp_seconds", Help: "informer 最近一次观察到 resourceVersion 前进的时间（含 watch bookmark 与重新列举）。"}, []string{"resource"}),
		watchErrors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "srenautix_reader_informer_watch_errors_total", Help: "informer 的 list/watch 错误次数。"}, []string{"resource"}),
		events: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "srenautix_reader_topology_events_total", Help: "产生的拓扑事件数。"}, []string{"op"}),
		nodes:      prometheus.NewGauge(prometheus.GaugeOpts{Name: "srenautix_reader_topology_nodes", Help: "当前拓扑节点数。"}),
		edges:      prometheus.NewGauge(prometheus.GaugeOpts{Name: "srenautix_reader_topology_edges", Help: "当前拓扑边数。"}),
		tombstones: prometheus.NewGauge(prometheus.GaugeOpts{Name: "srenautix_reader_tombstones", Help: "保留中的墓碑数。"}),
	}
	reg.MustRegister(m.synced, m.lastEvent, m.lastRV, m.watchErrors, m.events, m.nodes, m.edges, m.tombstones)
	return m
}

type resourceState struct {
	informer  cache.SharedIndexInformer
	synced    bool
	lastRV    string
	rvChanged time.Time
	lastErr   error
	lastErrAt time.Time
	lastEvent time.Time
}

// freshness 跟踪每个 informer 的同步与 watch 状态。watch 出错后，只有在 resourceVersion 再次前进
// （重新列举成功、收到事件或 bookmark）之后，才认为它已恢复。
type freshness struct {
	m  *metrics
	mu sync.Mutex
	rs map[string]*resourceState
}

func newFreshness(m *metrics) *freshness {
	return &freshness{m: m, rs: map[string]*resourceState{}}
}

func (f *freshness) track(name string, inf cache.SharedIndexInformer) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rs[name] = &resourceState{informer: inf}
	f.m.synced.WithLabelValues(name).Set(0)
}

func (f *freshness) untrack(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.rs, name)
	f.m.synced.DeleteLabelValues(name)
	f.m.lastEvent.DeleteLabelValues(name)
	f.m.lastRV.DeleteLabelValues(name)
}

func (f *freshness) markSynced(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.rs[name]
	s.synced = true
	s.lastRV = s.informer.LastSyncResourceVersion()
	s.rvChanged = time.Now()
	f.m.synced.WithLabelValues(name).Set(1)
	f.m.lastRV.WithLabelValues(name).Set(float64(s.rvChanged.Unix()))
}

func (f *freshness) event(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.rs[name]
	if !ok {
		return
	}
	s.lastEvent = time.Now()
	f.m.lastEvent.WithLabelValues(name).Set(float64(s.lastEvent.Unix()))
}

func (f *freshness) watchError(name string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.rs[name]
	if !ok {
		return
	}
	s.lastErr = err
	s.lastErrAt = time.Now()
	f.m.watchErrors.WithLabelValues(name).Inc()
}

func (f *freshness) poll() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for name, s := range f.rs {
		if !s.synced {
			if s.informer.HasSynced() {
				s.synced = true
				f.m.synced.WithLabelValues(name).Set(1)
			} else {
				continue
			}
		}
		rv := s.informer.LastSyncResourceVersion()
		if rv != s.lastRV {
			s.lastRV = rv
			s.rvChanged = time.Now()
			f.m.lastRV.WithLabelValues(name).Set(float64(s.rvChanged.Unix()))
		}
	}
}

func (f *freshness) status() (bool, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var problems []string
	for name, s := range f.rs {
		switch {
		case !s.synced:
			problems = append(problems, name+": not synced")
		case !s.lastErrAt.IsZero() && s.lastErrAt.After(s.rvChanged):
			problems = append(problems, fmt.Sprintf("%s: watch error since %s: %v", name, s.lastErrAt.UTC().Format(time.RFC3339), s.lastErr))
		}
	}
	sort.Strings(problems)
	if len(problems) == 0 {
		return true, fmt.Sprintf("%d informers synced", len(f.rs))
	}
	return false, strings.Join(problems, "; ")
}
