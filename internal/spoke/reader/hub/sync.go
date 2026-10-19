package hub

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/Zzhihon/SreNautix/internal/spoke/reader/topology"
)

const (
	snapshotPartItems = 5000
	eventBatchMax     = 1000
	// bufferMax 是等待推送的事件上限；超过时丢弃缓冲，改为在下一次推送前重新上传快照（快照覆盖被丢弃的全部变化）
	bufferMax = 200000
)

// Syncer 把本地拓扑同步到中心：每次连接先上传完整快照，之后按序号推送增量事件；
// 中心报告序号不连续或要求重新同步时，重新上传快照。事件按 event_id 幂等，失败重试不会产生重复变更。
type Syncer struct {
	client   *Client
	store    *topology.Store
	hello    Hello
	backoff  time.Duration
	onStatus func(connected bool, err error)

	mu       sync.Mutex
	buf      []topology.Event
	acked    int64
	overflow bool
	wake     chan struct{}
	broken   chan error

	pushedSeq prometheus.Gauge
	buffered  prometheus.Gauge
	resyncs   prometheus.Counter
	errors    *prometheus.CounterVec
	connected prometheus.Gauge
}

// NewSyncer 创建 Syncer。onStatus 在连接状态变化时调用（用于 TunnelConnected 条件）。
func NewSyncer(client *Client, store *topology.Store, hello Hello, backoff time.Duration, onStatus func(bool, error), reg prometheus.Registerer) *Syncer {
	s := &Syncer{client: client, store: store, hello: hello, backoff: backoff, onStatus: onStatus, wake: make(chan struct{}, 1), broken: make(chan error, 1),
		pushedSeq: prometheus.NewGauge(prometheus.GaugeOpts{Name: "srenautix_reader_topology_pushed_seq", Help: "中心已确认的拓扑序号。"}),
		buffered:  prometheus.NewGauge(prometheus.GaugeOpts{Name: "srenautix_reader_topology_buffered_events", Help: "等待推送的拓扑事件数。"}),
		resyncs:   prometheus.NewCounter(prometheus.CounterOpts{Name: "srenautix_reader_topology_resyncs_total", Help: "上传完整快照的次数。"}),
		errors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "srenautix_reader_tunnel_errors_total", Help: "到中心的请求失败次数，按操作。"}, []string{"op"}),
		connected: prometheus.NewGauge(prometheus.GaugeOpts{Name: "srenautix_reader_tunnel_connected", Help: "拓扑同步通道是否已连接（1 是，0 否）。"}),
	}
	reg.MustRegister(s.pushedSeq, s.buffered, s.resyncs, s.errors, s.connected)
	return s
}

// Errors 返回按操作计数的错误指标，供其他循环共用。
func (s *Syncer) Errors() *prometheus.CounterVec { return s.errors }

// Enqueue 接收 Watcher 产生的事件。不阻塞。
func (s *Syncer) Enqueue(evs []topology.Event) {
	s.mu.Lock()
	if !s.overflow {
		s.buf = append(s.buf, evs...)
		if len(s.buf) > bufferMax {
			s.buf = nil
			s.overflow = true
		}
	}
	s.buffered.Set(float64(len(s.buf)))
	s.mu.Unlock()
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Broken 报告其他循环（心跳等）发现的中心不可达。当前会话结束，按退避重新连接；重新连接后以快照开始，
// 断开期间的变化由快照补齐。
func (s *Syncer) Broken(err error) {
	select {
	case s.broken <- err:
	default:
	}
}

// Run 运行同步循环，直到 ctx 结束。
func (s *Syncer) Run(ctx context.Context) {
	for ctx.Err() == nil {
		err := s.session(ctx)
		if ctx.Err() != nil {
			return
		}
		s.connected.Set(0)
		s.onStatus(false, err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(s.backoff):
		}
	}
}

// session 建立一次会话：hello、上传快照、循环推送事件，直到出错。
func (s *Syncer) session(ctx context.Context) error {
	sess, err := s.client.Hello(ctx, s.hello)
	if err != nil {
		s.errors.WithLabelValues("hello").Inc()
		return err
	}
	s.store.RaiseSeq(sess.TopologySeq)
	if err := s.resync(ctx); err != nil {
		return err
	}
	s.connected.Set(1)
	s.onStatus(true, nil)
	// 清掉上一次会话期间积累的故障报告
	select {
	case <-s.broken:
	default:
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-s.broken:
			return err
		case <-s.wake:
		case <-time.After(time.Second):
		}
		for {
			s.mu.Lock()
			// 事件在快照之前产生、在快照之后才进入缓冲时，它的变化已包含在快照中
			keep := s.buf[:0]
			for _, e := range s.buf {
				if e.Seq > s.acked {
					keep = append(keep, e)
				}
			}
			s.buf = keep
			overflow := s.overflow
			n := min(len(s.buf), eventBatchMax)
			batch := append([]topology.Event(nil), s.buf[:n]...)
			s.mu.Unlock()
			if overflow {
				if err := s.resync(ctx); err != nil {
					return err
				}
				continue
			}
			if n == 0 {
				break
			}
			ack, err := s.client.PushEvents(ctx, EventBatch{Events: batch})
			if NeedsResync(err) {
				if err := s.resync(ctx); err != nil {
					return err
				}
				continue
			}
			if err != nil {
				s.errors.WithLabelValues("events").Inc()
				return err
			}
			if ack.TopologySeq < batch[n-1].Seq {
				return fmt.Errorf("hub acknowledged topology_seq %d after events up to %d", ack.TopologySeq, batch[n-1].Seq)
			}
			s.pushedSeq.Set(float64(ack.TopologySeq))
			s.mu.Lock()
			s.acked = ack.TopologySeq
			s.buf = s.buf[n:]
			s.buffered.Set(float64(len(s.buf)))
			s.mu.Unlock()
		}
	}
}

// resync 上传完整快照，并丢弃缓冲中已被快照覆盖的事件。
func (s *Syncer) resync(ctx context.Context) error {
	s.mu.Lock()
	s.overflow = false
	s.mu.Unlock()
	snap := s.store.Snapshot(time.Now())
	s.resyncs.Inc()
	parts := max(1, (len(snap.Nodes)+snapshotPartItems-1)/snapshotPartItems+(len(snap.Edges)+snapshotPartItems-1)/snapshotPartItems)
	id := uuid.NewString()
	part := 0
	send := func(nodes []topology.SnapshotNode, edges []topology.SnapshotEdge) error {
		part++
		ack, err := s.client.PutSnapshotPart(ctx, SnapshotPart{SnapshotID: id, Seq: snap.Seq, TakenAt: snap.TakenAt, Part: part, Parts: parts,
			Nodes: nodes, Edges: edges})
		if err != nil {
			s.errors.WithLabelValues("snapshot").Inc()
			return err
		}
		if part == parts {
			if !ack.Complete || ack.TopologySeq != snap.Seq {
				return fmt.Errorf("hub did not apply snapshot %s (complete=%v, topology_seq=%d, want %d)", id, ack.Complete, ack.TopologySeq, snap.Seq)
			}
			s.pushedSeq.Set(float64(ack.TopologySeq))
		}
		return nil
	}
	for i := 0; i < len(snap.Nodes); i += snapshotPartItems {
		if err := send(snap.Nodes[i:min(i+snapshotPartItems, len(snap.Nodes))], []topology.SnapshotEdge{}); err != nil {
			return err
		}
	}
	for i := 0; i < len(snap.Edges); i += snapshotPartItems {
		if err := send([]topology.SnapshotNode{}, snap.Edges[i:min(i+snapshotPartItems, len(snap.Edges))]); err != nil {
			return err
		}
	}
	if part == 0 {
		if err := send([]topology.SnapshotNode{}, []topology.SnapshotEdge{}); err != nil {
			return err
		}
	}
	s.mu.Lock()
	s.acked = snap.Seq
	keep := s.buf[:0]
	for _, e := range s.buf {
		if e.Seq > snap.Seq {
			keep = append(keep, e)
		}
	}
	s.buf = keep
	s.buffered.Set(float64(len(s.buf)))
	s.mu.Unlock()
	return nil
}
