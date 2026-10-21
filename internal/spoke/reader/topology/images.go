package topology

import (
	"regexp"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
)

var runtimePrefix = regexp.MustCompile(`^[a-z-]+://`)

// NormalizeImage 把镜像引用转换成比较用的形式，与中心 packages/core 的 normalizeImage 相同（ADR 0104 §13）：
// 去掉容器运行时前缀（docker-pullable://、containerd:// 等）；带 digest 的引用只保留 sha256:…；
// 已经是 sha256:… 的保持不变；其余转为小写。
func NormalizeImage(ref string) string {
	s := runtimePrefix.ReplaceAllString(strings.TrimSpace(ref), "")
	if i := strings.Index(s, "@sha256:"); i >= 0 {
		return s[i+1:]
	}
	if strings.HasPrefix(s, "sha256:") {
		return s
	}
	return strings.ToLower(s)
}

// PodImages 返回 Pod 的镜像：普通容器 spec 中的 image 与 status 中的 imageID（digest），规范化后去重、按字典序排列。
// 与 kube-state-metrics 的 kube_pod_container_info 一致，只取普通容器：init 容器（wait-for-db 之类的辅助镜像）
// 会出现在发布与迁移 Job 两边，造成错误的关联；临时容器也不计入。只读镜像引用，不读环境变量与其他字段。
// 没有镜像时返回 nil。
func PodImages(pod *corev1.Pod) []string {
	set := map[string]bool{}
	add := func(ref string) {
		if strings.TrimSpace(ref) == "" {
			return
		}
		set[NormalizeImage(ref)] = true
	}
	for _, c := range pod.Spec.Containers {
		add(c.Image)
	}
	for _, s := range pod.Status.ContainerStatuses {
		add(s.ImageID)
	}
	if len(set) == 0 {
		return nil
	}
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
