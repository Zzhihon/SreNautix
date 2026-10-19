package topology

import (
	"regexp"
	"strings"
)

// hostToken 切出可能是主机名的片段：Service DNS 名只由字母、数字、点和连字符组成。
var hostToken = regexp.MustCompile(`[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]`)

var bareWithPort = regexp.MustCompile(`^([a-z0-9]([-a-z0-9]*[a-z0-9])?)(:[0-9]{1,5})?$`)

// ServiceRef 是在配置值中找到的 Service 引用。
type ServiceRef struct {
	Namespace string
	Name      string
}

// FindServiceRefs 在一个配置值（环境变量字面值或 ConfigMap 的值）中查找指向已存在 Service 的 DNS 名。
// 识别 <svc>.<ns>.svc.cluster.local、<svc>.<ns>.svc、<svc>.<ns>；只有整个值就是 <svc> 或 <svc>:<port> 时才识别同命名空间的短名，
// 避免把 "true"、"info" 之类的普通取值当成引用。值本身只在这里读取，不进入任何输出。
func FindServiceRefs(lk Lookup, namespace, value string) []ServiceRef {
	var out []ServiceRef
	seen := map[ServiceRef]bool{}
	add := func(r ServiceRef) {
		if !seen[r] && lk.ServiceExists(r.Namespace, r.Name) {
			seen[r] = true
			out = append(out, r)
		}
	}
	trimmed := strings.TrimSpace(value)
	if m := bareWithPort.FindStringSubmatch(trimmed); m != nil {
		add(ServiceRef{Namespace: namespace, Name: m[1]})
		return out
	}
	for _, tok := range hostToken.FindAllString(value, -1) {
		tok = strings.ToLower(tok)
		tok = strings.TrimSuffix(tok, ".cluster.local")
		tok = strings.TrimSuffix(tok, ".svc")
		parts := strings.Split(tok, ".")
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			continue
		}
		add(ServiceRef{Namespace: parts[1], Name: parts[0]})
	}
	return out
}
