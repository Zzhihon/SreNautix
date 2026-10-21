package topology

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
)

// 与中心 packages/core/src/topology/ksm.ts 的 normalizeImage 相同的用例：两边对同一个镜像给出相同的字符串，第 2 档才能比较。
func TestNormalizeImage(t *testing.T) {
	const digest = "sha256:" + "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	for in, want := range map[string]string{
		"ghcr.io/Acme/API:v1.2.3":                   "ghcr.io/acme/api:v1.2.3",
		"  registry.example/app:1  ":                "registry.example/app:1",
		"docker.io/library/app@" + digest:           digest,
		"docker-pullable://docker.io/app@" + digest: digest,
		"containerd://" + digest:                    digest,
		digest:                                      digest,
		"ghcr.io/acme/api:v1@" + digest:             digest,
	} {
		if got := NormalizeImage(in); got != want {
			t.Errorf("NormalizeImage(%q) = %q, want %q", in, got, want)
		}
	}
}

type noLookup struct{}

func (noLookup) ControllerOf(string, string, string) (OwnerRef, bool)     { return OwnerRef{}, false }
func (noLookup) ServiceExists(string, string) bool                        { return false }
func (noLookup) ConfigMap(string, string) (*corev1.ConfigMap, bool)       { return nil, false }
func (noLookup) PVC(string, string) (*corev1.PersistentVolumeClaim, bool) { return nil, false }
func (noLookup) PV(string) (*corev1.PersistentVolume, bool)               { return nil, false }
func (noLookup) CSINodePlugin(string, string) (*corev1.Pod, bool)         { return nil, false }
func (noLookup) Namespaces(labels.Selector) []string                      { return nil }
func (noLookup) Pods(string, labels.Selector) []*corev1.Pod               { return nil }

// Pod 节点带普通容器的 image 和 status 中的 imageID（digest），去重排序；init 容器（例如等待迁移的容器，
// 它与迁移 Job 可能是同一个镜像）与临时容器的镜像不计入，与 kube_pod_container_info 一致；
// 环境变量（含 Secret 引用）不进入节点；容器尚未启动时只有 spec 中的 image；没有容器时省略字段。
func TestPodNodeImages(t *testing.T) {
	const appDigest = "sha256:" + "aa00000000000000000000000000000000000000000000000000000000000000"
	const migDigest = "sha256:" + "bb00000000000000000000000000000000000000000000000000000000000000"
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "api-1", UID: "u1"},
		Spec: corev1.PodSpec{
			InitContainers: []corev1.Container{{Name: "migrate", Image: "ghcr.io/acme/migrate:v7"}},
			Containers: []corev1.Container{
				{Name: "api", Image: "ghcr.io/acme/api:v7", Env: []corev1.EnvVar{
					{Name: "DB_PASSWORD", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
						LocalObjectReference: corev1.LocalObjectReference{Name: "db"}, Key: "password"}}},
					{Name: "TOKEN", Value: "do-not-leak"},
				}},
				{Name: "sidecar", Image: "ghcr.io/acme/api:v7"},
			},
			EphemeralContainers: []corev1.EphemeralContainer{{EphemeralContainerCommon: corev1.EphemeralContainerCommon{Name: "debug", Image: "busybox"}}},
		},
		Status: corev1.PodStatus{
			InitContainerStatuses: []corev1.ContainerStatus{{Name: "migrate", ImageID: "docker-pullable://ghcr.io/acme/migrate@" + migDigest}},
			ContainerStatuses: []corev1.ContainerStatus{
				{Name: "api", ImageID: "ghcr.io/acme/api@" + appDigest},
				{Name: "sidecar", ImageID: ""},
			},
		},
	}
	c := Pod(noLookup{}, pod)
	n := c.Nodes[0].Node
	if !c.Nodes[0].Own || n.Key != "Pod:shop/api-1" {
		t.Fatalf("first node %+v", c.Nodes[0])
	}
	want := []string{"ghcr.io/acme/api:v7", appDigest}
	if !reflect.DeepEqual(n.Images, want) {
		t.Fatalf("images %v, want %v", n.Images, want)
	}
	for _, img := range n.Images {
		if strings.Contains(img, "migrate") || img == migDigest {
			t.Fatalf("init container image %s in images", img)
		}
	}
	// Pod 节点只多了镜像：没有环境变量名、取值、Secret 键与临时容器；整个贡献中没有环境变量的取值
	// （配置引用边的依据只写环境变量名，见 ADR 0030）
	node, err := json.Marshal(n)
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"do-not-leak", "DB_PASSWORD", "password", "busybox"} {
		if strings.Contains(string(node), leak) {
			t.Fatalf("pod node contains %q: %s", leak, node)
		}
	}
	raw, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "do-not-leak") {
		t.Fatalf("contribution contains an environment value: %s", raw)
	}
	// 只有 Pod 自己的节点带镜像
	for _, nc := range c.Nodes[1:] {
		if nc.Node.Images != nil {
			t.Fatalf("node %s carries images", nc.Node.Key)
		}
	}

	// 容器尚未启动：只有 spec 中的 image
	pod.Status = corev1.PodStatus{}
	if got := Pod(noLookup{}, pod).Nodes[0].Node.Images; !reflect.DeepEqual(got, []string{"ghcr.io/acme/api:v7"}) {
		t.Fatalf("images before start %v", got)
	}
	// 只有 init 容器带镜像：省略字段
	empty := Pod(noLookup{}, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "x"},
		Spec:   corev1.PodSpec{InitContainers: []corev1.Container{{Name: "wait", Image: "ghcr.io/acme/migrate:v7"}}},
		Status: corev1.PodStatus{InitContainerStatuses: []corev1.ContainerStatus{{Name: "wait", ImageID: "ghcr.io/acme/migrate@" + migDigest}}},
	}).Nodes[0].Node
	b, _ := json.Marshal(empty)
	if empty.Images != nil || strings.Contains(string(b), "images") {
		t.Fatalf("empty pod node %s", b)
	}
}
