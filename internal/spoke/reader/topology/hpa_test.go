package topology

import (
	"testing"

	autoscalingv2 "k8s.io/api/autoscaling/v2"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"
)

func hpa(target autoscalingv2.CrossVersionObjectReference, owners ...metav1.OwnerReference) *autoscalingv2.HorizontalPodAutoscaler {
	return &autoscalingv2.HorizontalPodAutoscaler{
		ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "api", UID: "uid-hpa", OwnerReferences: owners},
		Spec:       autoscalingv2.HorizontalPodAutoscalerSpec{ScaleTargetRef: target, MaxReplicas: 4},
	}
}

func edgeIDs(c Contribution) []string {
	out := make([]string, 0, len(c.Edges))
	for _, e := range c.Edges {
		out = append(out, e.ID())
	}
	return out
}

// HPA → spec.scaleTargetRef 的 scales 边与中心 packages/core/src/topology/kube.ts 相同：结构性、置信度 1、作用范围 service，
// 依据写 spec.scaleTargetRef <kind>/<name>；伸缩对象补一个占位节点。
func TestHPAScalesTarget(t *testing.T) {
	c := HPA(hpa(autoscalingv2.CrossVersionObjectReference{APIVersion: "apps/v1", Kind: "Deployment", Name: "api"}))
	if len(c.Problems) != 0 {
		t.Fatalf("problems %+v", c.Problems)
	}
	if len(c.Nodes) != 2 || c.Nodes[0].Node.Key != "HorizontalPodAutoscaler:shop/api" || !c.Nodes[0].Own || *c.Nodes[0].Node.UID != "uid-hpa" {
		t.Fatalf("nodes %+v", c.Nodes)
	}
	if n := c.Nodes[1]; n.Own || n.Node.Key != "Deployment:shop/api" || n.Node.UID != nil {
		t.Fatalf("target placeholder %+v", n)
	}
	want := Edge{From: "HorizontalPodAutoscaler:shop/api", To: "Deployment:shop/api", Relation: RelScales, Provenance: ProvStructural,
		Confidence: 1, Scope: ScopeService, Evidence: "spec.scaleTargetRef Deployment/api"}
	if len(c.Edges) != 1 || c.Edges[0] != want {
		t.Fatalf("edges %+v", c.Edges)
	}
}

// 自定义资源的伸缩对象（Argo Rollout）按 apiVersion 的组写成 Kind.group；HPA 有控制者（KEDA ScaledObject）时 owner 边照常产生。
func TestHPAScalesCustomResourceAndKeepsOwner(t *testing.T) {
	c := HPA(hpa(autoscalingv2.CrossVersionObjectReference{APIVersion: "argoproj.io/v1alpha1", Kind: "Rollout", Name: "api"},
		metav1.OwnerReference{APIVersion: "keda.sh/v1alpha1", Kind: "ScaledObject", Name: "api", UID: "uid-so", Controller: ptr.To(true)}))
	got := edgeIDs(c)
	want := []string{
		"HorizontalPodAutoscaler:shop/api|owned_by|ScaledObject.keda.sh:shop/api",
		"HorizontalPodAutoscaler:shop/api|scales|Rollout.argoproj.io:shop/api",
	}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("edges %v, want %v", got, want)
	}
}

// scaleTargetRef 不完整时不产生 scales 边；apiVersion 无法解析时只记录问题，HPA 节点照常贡献。
func TestHPAIncompleteOrInvalidTarget(t *testing.T) {
	c := HPA(hpa(autoscalingv2.CrossVersionObjectReference{APIVersion: "apps/v1", Kind: "Deployment"}))
	if len(c.Edges) != 0 || len(c.Nodes) != 1 || len(c.Problems) != 0 {
		t.Fatalf("missing name: %+v", c)
	}
	c = HPA(hpa(autoscalingv2.CrossVersionObjectReference{APIVersion: "apps/v1/extra", Kind: "Deployment", Name: "api"}))
	if len(c.Edges) != 0 || len(c.Nodes) != 1 || len(c.Problems) != 1 || c.Problems[0].InvalidKey {
		t.Fatalf("invalid apiVersion: %+v", c)
	}
}
