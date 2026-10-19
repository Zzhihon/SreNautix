// Package verify 用本地只读的 Prometheus API 客户端评估执行后校验条件（DESIGN §6.1、§9.4）：
// 只执行审批时随参数声明的 PromQL 即时查询，结果中的每个样本都必须满足阈值比较；不使用 CEL。
package verify

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/api"
	promv1 "github.com/prometheus/client_golang/api/prometheus/v1"
	"github.com/prometheus/common/model"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/catalog"
)

// Client 是只读的指标查询客户端（Prometheus API，兼容 VictoriaMetrics）。
type Client struct {
	api     promv1.API
	timeout time.Duration
}

// New 创建客户端；timeout 是单次查询的上限。
func New(url string, timeout time.Duration) (*Client, error) {
	c, err := api.NewClient(api.Config{Address: url, RoundTripper: http.DefaultTransport})
	if err != nil {
		return nil, err
	}
	return &Client{api: promv1.NewAPI(c), timeout: timeout}, nil
}

// Result 是一个条件的评估结果。
type Result struct {
	ID     string
	Passed bool
	Detail string
}

func compare(op string, v, th float64) (bool, error) {
	switch op {
	case "lt":
		return v < th, nil
	case "le":
		return v <= th, nil
	case "gt":
		return v > th, nil
	case "ge":
		return v >= th, nil
	case "eq":
		return v == th, nil
	case "ne":
		return v != th, nil
	}
	return false, fmt.Errorf("unknown operator %q", op)
}

// Evaluate 在 at 时刻评估一个条件。查询失败返回错误（调用方记为校验失败）；NaN 不满足任何比较。
func (c *Client) Evaluate(ctx context.Context, cond catalog.Condition, at time.Time) (Result, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	v, _, err := c.api.Query(ctx, cond.Query, at)
	if err != nil {
		return Result{}, fmt.Errorf("query %s: %w", cond.ID, err)
	}
	var values []float64
	var labels []string
	switch r := v.(type) {
	case model.Vector:
		for _, s := range r {
			values = append(values, float64(s.Value))
			labels = append(labels, s.Metric.String())
		}
	case *model.Scalar:
		values, labels = []float64{float64(r.Value)}, []string{"scalar"}
	default:
		return Result{}, fmt.Errorf("query %s returned %s, want a vector or scalar", cond.ID, v.Type())
	}
	if len(values) == 0 {
		return Result{ID: cond.ID, Passed: cond.OnEmpty == "pass", Detail: "empty result, on_empty=" + cond.OnEmpty}, nil
	}
	passed := true
	var parts []string
	for i, val := range values {
		ok, err := compare(cond.Op, val, cond.Threshold)
		if err != nil {
			return Result{}, err
		}
		if math.IsNaN(val) {
			ok = false
		}
		passed = passed && ok
		parts = append(parts, fmt.Sprintf("%s=%s", labels[i], strconv.FormatFloat(val, 'g', -1, 64)))
	}
	return Result{ID: cond.ID, Passed: passed, Detail: fmt.Sprintf("%s %s %s: %s", cond.Query, cond.Op,
		strconv.FormatFloat(cond.Threshold, 'g', -1, 64), strings.Join(parts, ", "))}, nil
}
