package topology

import (
	"testing"

	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func pdb(ns, name string, sel *metav1.LabelSelector) *policyv1.PodDisruptionBudget {
	return &policyv1.PodDisruptionBudget{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name}, Spec: policyv1.PodDisruptionBudgetSpec{Selector: sel}}
}

// CNPG 为主库建的 PDB 选中实例 Pod，边指向它们的顶层对象 Cluster（SreNautix ADR 0203）
func TestPDBProtectsTheTopOwnerOfTheSelectedPods(t *testing.T) {
	c := PDB(testCluster(), pdb("cchp-data", "cchp-postgres-primary",
		&metav1.LabelSelector{MatchLabels: map[string]string{"cnpg.io/cluster": "cchp-postgres"}}))
	if len(c.Problems) != 0 {
		t.Fatalf("problems: %v", c.Problems)
	}
	if len(c.Nodes) != 1 || c.Nodes[0].Node.Key != "PodDisruptionBudget:cchp-data/cchp-postgres-primary" {
		t.Fatalf("nodes: %+v", c.Nodes)
	}
	equal(t, edgeIDs(c), []string{"PodDisruptionBudget:cchp-data/cchp-postgres-primary|protects|Cluster.postgresql.cnpg.io:cchp-data/cchp-postgres"})
	if e := c.Edges[0]; e.Confidence != ConfProtects || e.Provenance != ProvStructural || e.Evidence != "spec.selector" {
		t.Fatalf("edge: %+v", e)
	}
}

// 没有选择器、选中不到 Pod 的 PDB 只贡献自己的节点；选择器写错时记一个问题
func TestPDBWithoutPodsHasNoEdges(t *testing.T) {
	for _, p := range []*policyv1.PodDisruptionBudget{
		pdb("cchp-prod", "none", nil),
		pdb("cchp-prod", "nobody", &metav1.LabelSelector{MatchLabels: map[string]string{"app": "missing"}}),
	} {
		if c := PDB(testCluster(), p); len(c.Edges) != 0 || len(c.Nodes) != 1 || len(c.Problems) != 0 {
			t.Fatalf("%s: %+v", p.Name, c)
		}
	}
	bad := PDB(testCluster(), pdb("cchp-prod", "bad", &metav1.LabelSelector{MatchExpressions: []metav1.LabelSelectorRequirement{{Key: "app", Operator: "Bogus"}}}))
	if len(bad.Edges) != 0 || len(bad.Problems) != 1 {
		t.Fatalf("bad selector: %+v", bad)
	}
}
