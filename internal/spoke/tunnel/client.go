package tunnel

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// ClusterHeader 是分支声明自身 cluster_id 的请求头；中心核对它与 token 对应的集群一致。
const ClusterHeader = "X-SreNautix-Cluster"

// Config 是到中心的连接设置。TokenFile 每次请求都重新读取，以便轮换。
type Config struct {
	BaseURL   string
	Cluster   string
	TokenFile string
	// CAFile 为空时使用系统根证书。
	CAFile string
	// Timeout 是单次非长轮询请求的上限。
	Timeout time.Duration
}

// Client 是分支到中心的 HTTP 客户端。
type Client struct {
	cfg  Config
	base *url.URL
	http *http.Client
}

// New 校验设置并创建客户端。
func New(cfg Config) (*Client, error) {
	u, err := url.Parse(strings.TrimRight(cfg.BaseURL, "/"))
	if err != nil {
		return nil, fmt.Errorf("hub url: %w", err)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return nil, fmt.Errorf("hub url %q must be http or https", cfg.BaseURL)
	}
	if cfg.Cluster == "" || cfg.TokenFile == "" {
		return nil, errors.New("hub cluster and token file are required")
	}
	if cfg.Timeout <= 0 {
		return nil, errors.New("hub timeout must be positive")
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	if cfg.CAFile != "" {
		pem, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, err
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("hub ca file %s has no certificates", cfg.CAFile)
		}
		tr.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	}
	return &Client{cfg: cfg, base: u, http: &http.Client{
		Transport: tr,
		// 不跟随重定向，避免把 token 带到别的主机
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

// Cluster 返回本分支的 cluster_id。
func (c *Client) Cluster() string { return c.cfg.Cluster }

// HTTPError 是中心返回的非 2xx 响应。
type HTTPError struct {
	Status  int
	Problem Problem
	Path    string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("hub %s: HTTP %d %s: %s", e.Path, e.Status, e.Problem.Code, e.Problem.Message)
}

// Do 发送一个 JSON 请求；out 为 nil 时丢弃响应体。timeout 为 0 时使用配置的单次上限。
func (c *Client) Do(ctx context.Context, method, path string, query url.Values, in, out any, timeout time.Duration) error {
	if timeout == 0 {
		timeout = c.cfg.Timeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	token, err := os.ReadFile(c.cfg.TokenFile)
	if err != nil {
		return fmt.Errorf("hub token: %w", err)
	}
	u := *c.base
	u.Path = c.base.Path + path
	u.RawQuery = query.Encode()
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	req.Header.Set(ClusterHeader, c.cfg.Cluster)
	req.Header.Set("Accept", "application/json")
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("hub %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return fmt.Errorf("hub %s %s: %w", method, path, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		he := &HTTPError{Status: resp.StatusCode, Path: path}
		if err := json.Unmarshal(raw, &he.Problem); err != nil {
			he.Problem = Problem{Code: "http_" + strconv.Itoa(resp.StatusCode), Message: string(raw)}
		}
		return he
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("hub %s %s: decode: %w", method, path, err)
	}
	return nil
}

// PullTickets 长轮询拉取工单；wait 为中心没有工单时的最长等待。
func (c *Client) PullTickets(ctx context.Context, wait time.Duration, max int) (*TicketBatch, error) {
	q := url.Values{"wait": {strconv.Itoa(int(wait / time.Second))}, "max": {strconv.Itoa(max)}}
	var out TicketBatch
	if err := c.Do(ctx, http.MethodGet, "/v1/spoke/tickets", q, nil, &out, wait+c.cfg.Timeout); err != nil {
		return nil, err
	}
	return &out, nil
}

// PushEvents 推送执行事件（按 event_id 幂等）。
func (c *Client) PushEvents(ctx context.Context, events []ExecutionEvent) (*PushResult, error) {
	var out PushResult
	if err := c.Do(ctx, http.MethodPost, "/v1/spoke/events", nil, map[string]any{"events": events}, &out, 0); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetBinding 复核提议当前的绑定。
func (c *Client) GetBinding(ctx context.Context, proposalID string) (*Binding, error) {
	var out Binding
	if err := c.Do(ctx, http.MethodGet, "/v1/spoke/proposals/"+url.PathEscape(proposalID)+"/binding", nil, nil, &out, 0); err != nil {
		return nil, err
	}
	return &out, nil
}

// SendHeartbeat 上报状态并取回中心时间、恢复标记与软暂停。
func (c *Client) SendHeartbeat(ctx context.Context, hb Heartbeat) (*HubStatus, error) {
	var out HubStatus
	if err := c.Do(ctx, http.MethodPost, "/v1/spoke/heartbeat", nil, hb, &out, 0); err != nil {
		return nil, err
	}
	return &out, nil
}
