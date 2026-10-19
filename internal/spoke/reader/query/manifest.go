// Package query 执行中心下发的声明式证据查询（DESIGN §6.1、§7.5）。
//
// reader 只执行领域包证据卡模板渲染出的查询：模板清单（由领域包渲染、随 pack.lock 一起通过 GitOps 挂载）列出每个查询模板的
// ID、内容哈希、方言和参数类型。中心只发送模板 ID、内容哈希和参数值，查询文本由 reader 自己渲染；参数按类型转义，
// 渲染结果再用对应方言的解析器检查。清单里没有的模板、哈希不一致的模板、类型不符的参数一律拒绝。
package query

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"os"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/VictoriaMetrics/metricsql"
	"github.com/prometheus/common/model"
	"github.com/prometheus/prometheus/promql/parser"
	"sigs.k8s.io/yaml"
)

// Dialect 是查询方言（DESIGN §6.2）。
type Dialect string

const (
	DialectPromQL    Dialect = "promql"
	DialectMetricsQL Dialect = "metricsql"
)

// ParamType 是模板参数的类型。
type ParamType string

const (
	// ParamLabelValue 是单个标签值，渲染为双引号字符串内部的转义文本。
	ParamLabelValue ParamType = "label_value"
	// ParamLabelValues 是标签值列表，渲染为正则交替式 (a|b|c)，每个值按字面量转义；用于 =~ 匹配。
	ParamLabelValues ParamType = "label_values"
	// ParamDuration 是 Prometheus 时长（例如 5m），受 max 限制。
	ParamDuration ParamType = "duration"
	// ParamNumber 是有限的十进制数。
	ParamNumber ParamType = "number"
	// ParamEnum 是 values 中列出的取值之一，原样渲染。
	ParamEnum ParamType = "enum"
)

// Param 是参数声明。
type Param struct {
	Type   ParamType `json:"type"`
	Max    string    `json:"max,omitempty"`
	Values []string  `json:"values,omitempty"`
	// MaxItems 限制 label_values 的个数
	MaxItems int `json:"max_items,omitempty"`
}

// TemplateLimits 是单个模板更严格的限制；零值表示使用 reader 的全局限制。
type TemplateLimits struct {
	MaxRange  string `json:"max_range,omitempty"`
	MaxSeries int    `json:"max_series,omitempty"`
}

// Template 是一个声明过的查询模板。
type Template struct {
	ID          string           `json:"id"`
	ContentHash string           `json:"content_hash"`
	Dialect     Dialect          `json:"dialect"`
	Expr        string           `json:"expr"`
	Params      map[string]Param `json:"params"`
	Limits      TemplateLimits   `json:"limits"`

	maxRange time.Duration
	maxDur   map[string]time.Duration
}

// Manifest 是模板清单。
type Manifest struct {
	Version  int        `json:"version"`
	PackLock string     `json:"pack_lock"`
	Queries  []Template `json:"queries"`

	byID map[string]*Template
}

var placeholder = regexp.MustCompile(`\$([a-z_][a-z0-9_]*)`)
var sha256Pattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// ContentHash 计算模板定义的内容哈希：对方言、表达式、按名称排序的参数声明做 sha256。
// 领域包渲染清单时用同一算法写入 content_hash，reader 加载时重新计算并核对。
func ContentHash(t Template) string {
	h := sha256.New()
	fmt.Fprintf(h, "dialect=%s\nexpr=%s\n", t.Dialect, t.Expr)
	names := make([]string, 0, len(t.Params))
	for n := range t.Params {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		p := t.Params[n]
		fmt.Fprintf(h, "param=%s type=%s max=%s max_items=%d values=%s\n", n, p.Type, p.Max, p.MaxItems, strings.Join(p.Values, ","))
	}
	fmt.Fprintf(h, "limits max_range=%s max_series=%d\n", t.Limits.MaxRange, t.Limits.MaxSeries)
	return "sha256:" + hex.EncodeToString(h.Sum(nil))
}

// LoadManifest 读取并校验模板清单文件。
func LoadManifest(path string) (*Manifest, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return ParseManifest(b)
}

// ParseManifest 解析并校验模板清单。
func ParseManifest(b []byte) (*Manifest, error) {
	var m Manifest
	if err := yaml.UnmarshalStrict(b, &m); err != nil {
		return nil, fmt.Errorf("query manifest: %w", err)
	}
	if m.Version != 1 {
		return nil, fmt.Errorf("query manifest: unsupported version %d", m.Version)
	}
	if !sha256Pattern.MatchString(m.PackLock) {
		return nil, fmt.Errorf("query manifest: pack_lock %q is not a sha256 digest", m.PackLock)
	}
	m.byID = map[string]*Template{}
	for i := range m.Queries {
		t := &m.Queries[i]
		if err := t.validate(); err != nil {
			return nil, fmt.Errorf("query manifest: template %q: %w", t.ID, err)
		}
		if _, dup := m.byID[t.ID]; dup {
			return nil, fmt.Errorf("query manifest: duplicate template id %q", t.ID)
		}
		m.byID[t.ID] = t
	}
	return &m, nil
}

func (t *Template) validate() error {
	if t.ID == "" {
		return fmt.Errorf("empty id")
	}
	if t.Dialect != DialectPromQL && t.Dialect != DialectMetricsQL {
		return fmt.Errorf("unknown dialect %q", t.Dialect)
	}
	if got := ContentHash(*t); got != t.ContentHash {
		return fmt.Errorf("content_hash %s does not match the template definition (%s)", t.ContentHash, got)
	}
	used := map[string]bool{}
	for _, m := range placeholder.FindAllStringSubmatch(t.Expr, -1) {
		if _, ok := t.Params[m[1]]; !ok {
			return fmt.Errorf("placeholder $%s is not declared", m[1])
		}
		used[m[1]] = true
	}
	t.maxDur = map[string]time.Duration{}
	for name, p := range t.Params {
		if !used[name] {
			return fmt.Errorf("param %q is declared but not used", name)
		}
		switch p.Type {
		case ParamLabelValue, ParamNumber:
		case ParamLabelValues:
			if p.MaxItems <= 0 {
				return fmt.Errorf("param %q: label_values needs max_items", name)
			}
		case ParamDuration:
			d, err := model.ParseDuration(p.Max)
			if err != nil {
				return fmt.Errorf("param %q: duration needs a valid max: %w", name, err)
			}
			t.maxDur[name] = time.Duration(d)
		case ParamEnum:
			if len(p.Values) == 0 {
				return fmt.Errorf("param %q: enum needs values", name)
			}
		default:
			return fmt.Errorf("param %q: unknown type %q", name, p.Type)
		}
	}
	if t.Limits.MaxRange != "" {
		d, err := model.ParseDuration(t.Limits.MaxRange)
		if err != nil {
			return fmt.Errorf("limits.max_range: %w", err)
		}
		t.maxRange = time.Duration(d)
	}
	// 用每种类型的样例值渲染一次，确认模板本身能通过方言解析器
	sample := map[string]any{}
	for name, p := range t.Params {
		switch p.Type {
		case ParamLabelValue:
			sample[name] = "x"
		case ParamLabelValues:
			sample[name] = []any{"x"}
		case ParamDuration:
			sample[name] = "1m"
		case ParamNumber:
			sample[name] = 1.0
		case ParamEnum:
			sample[name] = p.Values[0]
		}
	}
	if _, err := t.Render(sample); err != nil {
		return fmt.Errorf("template does not render with sample values: %w", err)
	}
	return nil
}

// Lookup 按 ID 和内容哈希取模板。
func (m *Manifest) Lookup(id, contentHash string) (*Template, error) {
	t, ok := m.byID[id]
	if !ok {
		return nil, &Error{Code: CodeUndeclared, Message: fmt.Sprintf("query template %q is not declared", id)}
	}
	if t.ContentHash != contentHash {
		return nil, &Error{Code: CodeHashMismatch, Message: fmt.Sprintf("query template %q: content hash %s does not match the mounted manifest (%s)", id, contentHash, t.ContentHash)}
	}
	return t, nil
}

// Render 用参数值渲染查询文本，并用方言解析器检查结果。
func (t *Template) Render(params map[string]any) (string, error) {
	for name := range params {
		if _, ok := t.Params[name]; !ok {
			return "", &Error{Code: CodeBadParams, Message: fmt.Sprintf("param %q is not declared", name)}
		}
	}
	rendered := map[string]string{}
	for name, p := range t.Params {
		v, ok := params[name]
		if !ok {
			return "", &Error{Code: CodeBadParams, Message: fmt.Sprintf("param %q is missing", name)}
		}
		s, err := t.renderParam(name, p, v)
		if err != nil {
			return "", &Error{Code: CodeBadParams, Message: err.Error()}
		}
		rendered[name] = s
	}
	expr := placeholder.ReplaceAllStringFunc(t.Expr, func(m string) string { return rendered[m[1:]] })
	switch t.Dialect {
	case DialectPromQL:
		if _, err := parser.NewParser(parser.Options{}).ParseExpr(expr); err != nil {
			return "", &Error{Code: CodeBadParams, Message: fmt.Sprintf("rendered query does not parse as PromQL: %v", err)}
		}
	case DialectMetricsQL:
		if _, err := metricsql.Parse(expr); err != nil {
			return "", &Error{Code: CodeBadParams, Message: fmt.Sprintf("rendered query does not parse as MetricsQL: %v", err)}
		}
	}
	return expr, nil
}

// escapeString 转义双引号字符串的内部文本。PromQL 与 MetricsQL 的字符串字面量都使用 Go 的转义规则。
func escapeString(s string) string {
	q := strconv.Quote(s)
	return q[1 : len(q)-1]
}

func (t *Template) renderParam(name string, p Param, v any) (string, error) {
	switch p.Type {
	case ParamLabelValue:
		s, ok := v.(string)
		if !ok {
			return "", fmt.Errorf("param %q must be a string", name)
		}
		return escapeString(s), nil
	case ParamLabelValues:
		list, ok := v.([]any)
		if !ok || len(list) == 0 {
			return "", fmt.Errorf("param %q must be a non-empty list of strings", name)
		}
		if len(list) > p.MaxItems {
			return "", fmt.Errorf("param %q has %d items, max %d", name, len(list), p.MaxItems)
		}
		parts := make([]string, 0, len(list))
		for _, item := range list {
			s, ok := item.(string)
			if !ok {
				return "", fmt.Errorf("param %q must be a list of strings", name)
			}
			parts = append(parts, regexp.QuoteMeta(s))
		}
		return escapeString("(" + strings.Join(parts, "|") + ")"), nil
	case ParamDuration:
		s, ok := v.(string)
		if !ok {
			return "", fmt.Errorf("param %q must be a duration string", name)
		}
		d, err := model.ParseDuration(s)
		if err != nil {
			return "", fmt.Errorf("param %q: %w", name, err)
		}
		if time.Duration(d) <= 0 || time.Duration(d) > t.maxDur[name] {
			return "", fmt.Errorf("param %q: %s is outside (0, %s]", name, s, p.Max)
		}
		return d.String(), nil
	case ParamNumber:
		f, ok := v.(float64)
		if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
			return "", fmt.Errorf("param %q must be a finite number", name)
		}
		return strconv.FormatFloat(f, 'g', -1, 64), nil
	case ParamEnum:
		s, ok := v.(string)
		if !ok || !slices.Contains(p.Values, s) {
			return "", fmt.Errorf("param %q must be one of %v", name, p.Values)
		}
		return s, nil
	}
	return "", fmt.Errorf("param %q: unknown type %q", name, p.Type)
}
