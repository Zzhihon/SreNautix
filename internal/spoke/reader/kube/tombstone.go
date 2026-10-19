package kube

import (
	"sort"
	"sync"
	"time"

	"github.com/Zzhihon/SreNautix/internal/spoke/reader/topology"
)

// TombstoneTTL 是墓碑保留时长（DESIGN §3.3）。
const TombstoneTTL = 24 * time.Hour

// Tombstone 是已删除对象的最后状态，供删除后 24 小时内的实体解析使用。
type Tombstone struct {
	Node      topology.Node `json:"node"`
	PodIP     string        `json:"pod_ip,omitempty"`
	NodeName  string        `json:"node_name,omitempty"`
	RootOwner string        `json:"root_owner,omitempty"`
	CreatedAt time.Time     `json:"created_at"`
	DeletedAt time.Time     `json:"deleted_at"`
}

// Tombstones 按组件键和 Pod IP 索引已删除的对象。同一个键可能先后对应多个对象（例如 StatefulSet 的 Pod 重建），全部保留。
type Tombstones struct {
	mu    sync.Mutex
	byKey map[string][]Tombstone
	byIP  map[string][]Tombstone
}

// NewTombstones 创建空的墓碑表。
func NewTombstones() *Tombstones {
	return &Tombstones{byKey: map[string][]Tombstone{}, byIP: map[string][]Tombstone{}}
}

// Add 记录一个已删除的对象。
func (t *Tombstones) Add(ts Tombstone) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.byKey[ts.Node.Key] = append(t.byKey[ts.Node.Key], ts)
	if ts.PodIP != "" {
		t.byIP[ts.PodIP] = append(t.byIP[ts.PodIP], ts)
	}
}

// ByKey 返回在时刻 at 存活过的、键为 key 的墓碑；at 为零值时返回最近删除的一个。
func (t *Tombstones) ByKey(key string, at time.Time) (Tombstone, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return pick(t.byKey[key], at)
}

// ByPodIP 返回在时刻 at 使用过该 IP 的 Pod 墓碑；at 为零值时返回最近删除的一个。
func (t *Tombstones) ByPodIP(ip string, at time.Time) (Tombstone, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return pick(t.byIP[ip], at)
}

func pick(list []Tombstone, at time.Time) (Tombstone, bool) {
	if len(list) == 0 {
		return Tombstone{}, false
	}
	sorted := append([]Tombstone{}, list...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].DeletedAt.After(sorted[j].DeletedAt) })
	if at.IsZero() {
		return sorted[0], true
	}
	for _, ts := range sorted {
		if !at.Before(ts.CreatedAt) && !at.After(ts.DeletedAt) {
			return ts, true
		}
	}
	return Tombstone{}, false
}

// Expire 删除 DeletedAt 早于 now−TTL 的墓碑，返回剩余数量。
func (t *Tombstones) Expire(now time.Time) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	cutoff := now.Add(-TombstoneTTL)
	n := 0
	for k, list := range t.byKey {
		keep := list[:0]
		for _, ts := range list {
			if ts.DeletedAt.After(cutoff) {
				keep = append(keep, ts)
			}
		}
		if len(keep) == 0 {
			delete(t.byKey, k)
		} else {
			t.byKey[k] = keep
			n += len(keep)
		}
	}
	for ip, list := range t.byIP {
		keep := list[:0]
		for _, ts := range list {
			if ts.DeletedAt.After(cutoff) {
				keep = append(keep, ts)
			}
		}
		if len(keep) == 0 {
			delete(t.byIP, ip)
		} else {
			t.byIP[ip] = keep
		}
	}
	return n
}
