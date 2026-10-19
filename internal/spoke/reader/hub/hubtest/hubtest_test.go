package hubtest

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Zzhihon/SreNautix/internal/spoke/reader/testenv"
	"github.com/Zzhihon/SreNautix/internal/spoke/tunnel"
)

func client(t *testing.T, h *Server, token string) *tunnel.Client {
	t.Helper()
	dir := testenv.Scratch(t, "hubtest")
	if err := os.WriteFile(filepath.Join(dir, "token"), []byte(token), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := tunnel.New(tunnel.Config{BaseURL: h.URL(), Cluster: "edge-1", TokenFile: filepath.Join(dir, "token"), Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func status(err error) int {
	var he *tunnel.HTTPError
	if errors.As(err, &he) {
		return he.Status
	}
	return 0
}

// 进程内中心必须拒绝不符合契约的请求体，包括多层嵌套的引用（ReaderResult → QueryResult → ReaderError）。
func TestHubRejectsBodiesOutsideTheContract(t *testing.T) {
	h := Start(t, "edge-1", "tok")
	c := client(t, h, "tok")
	ctx := context.Background()
	id := "0b8f3c1e-2a44-4d1e-9a9e-3c6a1f0d5e77"

	if err := c.Do(ctx, http.MethodPost, "/v1/spoke/reader/hello", nil,
		map[string]any{"reader_id": "r", "version": "v", "boot_id": id}, nil, 0); err != nil {
		t.Fatalf("valid hello rejected: %v (%v)", err, h.Violations())
	}
	valid := map[string]any{"results": []any{map[string]any{"request_id": id, "kind": "query", "query": map[string]any{
		"status": "error", "error": map[string]any{"error": "bad_params", "message": "m"},
		"series": []any{}, "truncated": false, "clamped": []any{}, "warnings": []any{}, "executed_at": "2026-10-20T00:00:00Z", "duration_ms": 1}}}}
	if err := c.Do(ctx, http.MethodPost, "/v1/spoke/reader/results", nil, valid, nil, 0); err != nil {
		t.Fatalf("valid nested result rejected: %v (%v)", err, h.Violations())
	}
	if v := h.Violations(); len(v) != 0 {
		t.Fatalf("violations for valid requests: %v", v)
	}

	bad := []struct {
		name, path string
		body       any
	}{
		{"hello without boot_id", "/v1/spoke/reader/hello", map[string]any{"reader_id": "r", "version": "v"}},
		{"nested error code with upper case", "/v1/spoke/reader/results", map[string]any{"results": []any{map[string]any{"request_id": id, "kind": "query",
			"query": map[string]any{"status": "error", "error": map[string]any{"error": "Bad", "message": "m"},
				"series": []any{}, "truncated": false, "clamped": []any{}, "warnings": []any{}, "executed_at": "2026-10-20T00:00:00Z", "duration_ms": 1}}}}},
		{"nested timestamp not RFC 3339 UTC", "/v1/spoke/reader/results", map[string]any{"results": []any{map[string]any{"request_id": id, "kind": "query",
			"query": map[string]any{"status": "ok", "series": []any{}, "truncated": false, "clamped": []any{}, "warnings": []any{},
				"executed_at": "yesterday", "duration_ms": 1}}}}},
		{"topology event with unknown op", "/v1/spoke/reader/topology/events", map[string]any{"events": []any{map[string]any{
			"event_id": id, "cluster_id": "edge-1", "seq": 1, "op": "node_rename", "valid_from": "2026-10-20T00:00:00Z", "valid_to": nil,
			"source": "informer", "node": nil, "edge": nil}}}},
	}
	for _, b := range bad {
		before := len(h.Violations())
		err := c.Do(ctx, http.MethodPost, b.path, nil, b.body, nil, 0)
		if status(err) != http.StatusBadRequest || len(h.Violations()) != before+1 {
			t.Fatalf("%s: err=%v violations=%d→%d", b.name, err, before, len(h.Violations()))
		}
	}
	if err := client(t, h, "wrong").Do(ctx, http.MethodPost, "/v1/spoke/reader/hello", nil,
		map[string]any{"reader_id": "r", "version": "v", "boot_id": id}, nil, 0); status(err) != http.StatusUnauthorized {
		t.Fatalf("wrong token: %v", err)
	}
	for _, v := range h.Violations() {
		if strings.Contains(v, "hub response") {
			t.Fatalf("hub produced a response outside the contract: %s", v)
		}
	}
}
