package topology

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/labels"
)

// owners 是只提供 controller 关系的 Lookup：键为 kind/namespace/name。
type owners map[string]OwnerRef

func (o owners) ControllerOf(kind, namespace, name string) (OwnerRef, bool) {
	r, ok := o[kind+"/"+namespace+"/"+name]
	return r, ok
}
func (owners) ServiceExists(string, string) bool                        { return false }
func (owners) ConfigMap(string, string) (*corev1.ConfigMap, bool)       { return nil, false }
func (owners) PVC(string, string) (*corev1.PersistentVolumeClaim, bool) { return nil, false }
func (owners) PV(string) (*corev1.PersistentVolume, bool)               { return nil, false }
func (owners) CSINodePlugin(string, string) (*corev1.Pod, bool)         { return nil, false }
func (owners) Namespaces(labels.Selector) []string                      { return nil }
func (owners) Pods(string, labels.Selector) []*corev1.Pod               { return nil }

func TestRootOwnerClusterScopedOwnerHasNoNamespace(t *testing.T) {
	lk := owners{
		"Pod/kube-system/etcd-cp-01": {Kind: "Node", Name: "cp-01"},
		"Pod/app/api-1":              {Kind: "ReplicaSet", Name: "api-rs"},
		"ReplicaSet/app/api-rs":      {Kind: "Deployment", Name: "api"},
	}
	for _, c := range []struct{ kind, ns, name, want string }{
		{"Pod", "kube-system", "etcd-cp-01", "Node:cp-01"},
		{"Pod", "app", "api-1", "Deployment:app/api"},
		{"Pod", "app", "orphan", "Pod:app/orphan"},
		{"Node", "", "cp-01", "Node:cp-01"},
	} {
		got, err := RootOwner(lk, c.kind, c.ns, c.name)
		if err != nil || got != c.want {
			t.Fatalf("RootOwner(%s %s/%s) = %q, %v; want %q", c.kind, c.ns, c.name, got, err, c.want)
		}
	}
	if OwnerNamespace("Node", "kube-system") != "" || OwnerNamespace("ClusterRole", "app") != "" || OwnerNamespace("Deployment", "app") != "app" {
		t.Fatal("OwnerNamespace")
	}
}
