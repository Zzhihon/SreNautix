package hub

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/Zzhihon/SreNautix/internal/spoke/reader/health"
	"github.com/Zzhihon/SreNautix/internal/spoke/tunnel"
)

// 中心返回的、要求 reader 重新上传快照的错误码。
const (
	ProblemSeqGap         = "topology_seq_gap"
	ProblemResyncRequired = "resync_required"
)

// Client 是 reader 到中心的客户端。
type Client struct {
	t *tunnel.Client
}

// NewClient 包装出站客户端。
func NewClient(t *tunnel.Client) *Client { return &Client{t: t} }

// Hello 建立会话。
func (c *Client) Hello(ctx context.Context, h Hello) (*Session, error) {
	var out Session
	if err := c.t.Do(ctx, http.MethodPost, "/v1/spoke/reader/hello", nil, h, &out, 0); err != nil {
		return nil, err
	}
	return &out, nil
}

// PutSnapshotPart 上传快照分段。
func (c *Client) PutSnapshotPart(ctx context.Context, p SnapshotPart) (*TopologyAck, error) {
	var out TopologyAck
	if err := c.t.Do(ctx, http.MethodPut, "/v1/spoke/reader/topology/snapshot", nil, p, &out, 0); err != nil {
		return nil, err
	}
	return &out, nil
}

// PushEvents 推送拓扑事件。
func (c *Client) PushEvents(ctx context.Context, b EventBatch) (*TopologyAck, error) {
	var out TopologyAck
	if err := c.t.Do(ctx, http.MethodPost, "/v1/spoke/reader/topology/events", nil, b, &out, 0); err != nil {
		return nil, err
	}
	return &out, nil
}

// PushAlerts 推送告警对账快照。
func (c *Client) PushAlerts(ctx context.Context, s AlertSnapshot) (*tunnel.HubClock, error) {
	var out tunnel.HubClock
	if err := c.t.Do(ctx, http.MethodPost, "/v1/spoke/reader/alerts", nil, s, &out, 0); err != nil {
		return nil, err
	}
	return &out, nil
}

// PullRequests 长轮询领取读取请求。
func (c *Client) PullRequests(ctx context.Context, wait time.Duration, max int) (*RequestBatch, error) {
	q := url.Values{"wait": {strconv.Itoa(int(wait / time.Second))}, "max": {strconv.Itoa(max)}}
	var out RequestBatch
	if err := c.t.Do(ctx, http.MethodGet, "/v1/spoke/reader/requests", q, nil, &out, wait+30*time.Second); err != nil {
		return nil, err
	}
	return &out, nil
}

// PushResults 回传读取结果。
func (c *Client) PushResults(ctx context.Context, b ResultBatch) (*PushResult, error) {
	var out PushResult
	if err := c.t.Do(ctx, http.MethodPost, "/v1/spoke/reader/results", nil, b, &out, 0); err != nil {
		return nil, err
	}
	return &out, nil
}

// PushHealth 上报当前不健康的对象（集群状态检测器）。
func (c *Client) PushHealth(ctx context.Context, r health.Report) error {
	return c.t.Do(ctx, http.MethodPost, "/v1/spoke/reader/health", nil, r, nil, 0)
}

// SendHeartbeat 上报心跳。
func (c *Client) SendHeartbeat(ctx context.Context, hb Heartbeat) (*tunnel.HubClock, error) {
	var out tunnel.HubClock
	if err := c.t.Do(ctx, http.MethodPost, "/v1/spoke/reader/heartbeat", nil, hb, &out, 0); err != nil {
		return nil, err
	}
	return &out, nil
}

// NeedsResync 判断错误是否要求重新上传快照。
func NeedsResync(err error) bool {
	var he *tunnel.HTTPError
	if !errors.As(err, &he) || he.Status != http.StatusConflict {
		return false
	}
	return he.Problem.Code == ProblemSeqGap || he.Problem.Code == ProblemResyncRequired
}
