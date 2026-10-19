package topology

import (
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/labels"
)

// OwnerRef 是解析后的 owner 引用。
type OwnerRef struct {
	Kind string // ComponentKey 中的 kind 名称
	Name string
	UID  string
}

// Lookup 提供跨对象的查询，供需要关联其他对象的提取函数使用。实现基于 informer 缓存。
type Lookup interface {
	// ControllerOf 返回 kind/namespace/name 对象的 controller owner；没有或对象不在缓存中时 ok 为 false。
	ControllerOf(kind, namespace, name string) (OwnerRef, bool)
	// ServiceExists 判断 Service 是否存在。
	ServiceExists(namespace, name string) bool
	// ConfigMap 返回缓存中的 ConfigMap。
	ConfigMap(namespace, name string) (*corev1.ConfigMap, bool)
	// PVC 返回缓存中的 PersistentVolumeClaim。
	PVC(namespace, name string) (*corev1.PersistentVolumeClaim, bool)
	// PV 返回缓存中的 PersistentVolume。
	PV(name string) (*corev1.PersistentVolume, bool)
	// CSINodePlugin 返回节点 node 上为 driver 注册的 CSI node plugin Pod。
	CSINodePlugin(driver, node string) (*corev1.Pod, bool)
	// Namespaces 返回标签满足 selector 的命名空间名。
	Namespaces(selector labels.Selector) []string
	// Pods 返回命名空间 namespace 中标签满足 selector 的 Pod。
	Pods(namespace string, selector labels.Selector) []*corev1.Pod
}

// RootOwner 沿 controller owner 链向上，返回最顶层的 owner 键（例如 Pod → ReplicaSet → Deployment）。
// 没有 controller 的对象返回它自己的键。
func RootOwner(lk Lookup, kind, namespace, name string) string {
	k, n := kind, name
	for range 6 {
		ref, ok := lk.ControllerOf(k, namespace, n)
		if !ok {
			break
		}
		k, n = ref.Kind, ref.Name
	}
	return Key(k, namespace, n)
}
