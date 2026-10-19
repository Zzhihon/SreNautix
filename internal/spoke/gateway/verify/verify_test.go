package verify_test

import (
	"context"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/catalog"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/verify"
	"github.com/Zzhihon/SreNautix/internal/spoke/testenv"
)

func TestEvaluateAgainstPrometheus(t *testing.T) {
	p := testenv.StartPrometheus(t)
	g := prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "drill_error_ratio"}, []string{"pod"})
	p.Registry.MustRegister(g)
	g.WithLabelValues("a").Set(0.01)
	g.WithLabelValues("b").Set(0.2)
	c, err := verify.New(p.URL, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	testenv.Eventually(t, 30*time.Second, "series scraped", func() (bool, string) {
		r, err := c.Evaluate(ctx, catalog.Condition{ID: "present", Query: "count(drill_error_ratio)", Op: "eq", Threshold: 2, OnEmpty: "fail"}, time.Now())
		if err != nil {
			return false, err.Error()
		}
		return r.Passed, r.Detail
	})
	cases := []struct {
		cond catalog.Condition
		want bool
	}{
		{catalog.Condition{ID: "all_below", Query: "drill_error_ratio", Op: "lt", Threshold: 0.5, OnEmpty: "fail"}, true},
		{catalog.Condition{ID: "one_above", Query: "drill_error_ratio", Op: "lt", Threshold: 0.1, OnEmpty: "fail"}, false},
		{catalog.Condition{ID: "max", Query: "max(drill_error_ratio)", Op: "le", Threshold: 0.2, OnEmpty: "fail"}, true},
		{catalog.Condition{ID: "empty_fail", Query: "drill_error_ratio{pod=\"zzz\"}", Op: "lt", Threshold: 1, OnEmpty: "fail"}, false},
		{catalog.Condition{ID: "empty_pass", Query: "drill_error_ratio{pod=\"zzz\"}", Op: "lt", Threshold: 1, OnEmpty: "pass"}, true},
		{catalog.Condition{ID: "scalar", Query: "scalar(max(drill_error_ratio))", Op: "gt", Threshold: 0.1, OnEmpty: "fail"}, true},
		{catalog.Condition{ID: "never", Query: "vector(1)", Op: "lt", Threshold: 0, OnEmpty: "fail"}, false},
	}
	for _, tc := range cases {
		r, err := c.Evaluate(ctx, tc.cond, time.Now())
		if err != nil {
			t.Fatalf("%s: %v", tc.cond.ID, err)
		}
		if r.Passed != tc.want {
			t.Errorf("%s: passed=%v, %s", tc.cond.ID, r.Passed, r.Detail)
		}
	}
	if _, err := c.Evaluate(ctx, catalog.Condition{ID: "bad", Query: "sum(", Op: "lt", Threshold: 1}, time.Now()); err == nil {
		t.Fatal("malformed query evaluated")
	}
}
