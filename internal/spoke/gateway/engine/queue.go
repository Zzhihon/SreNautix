package engine

import (
	"sort"
	"sync"

	"github.com/Zzhihon/SreNautix/internal/spoke/tunnel"
)

// queue 是主实例内存中的冲突域队列：同一冲突域串行，不同冲突域并行；切换主实例时从 ActionExecution 重建。
type queue struct {
	mu      sync.Mutex
	waiting map[string][]string // 冲突域 → 排队中的执行 ID（按拉取顺序）
	active  map[string]string   // 冲突域 → 执行中的执行 ID
	domain  map[string]string   // 执行 ID → 冲突域
}

func newQueue() *queue {
	return &queue{waiting: map[string][]string{}, active: map[string]string{}, domain: map[string]string{}}
}

// add 把执行放到冲突域队尾，返回排队位置（从 1 开始，包括执行中的那个）。已在队列中时不重复加入。
func (q *queue) add(domain, id string) int {
	q.mu.Lock()
	defer q.mu.Unlock()
	if _, ok := q.domain[id]; !ok {
		q.domain[id] = domain
		q.waiting[domain] = append(q.waiting[domain], id)
	}
	pos := 0
	if _, busy := q.active[domain]; busy {
		pos = 1
	}
	for i, w := range q.waiting[domain] {
		if w == id {
			return pos + i + 1
		}
	}
	return 0
}

// position 返回执行在冲突域中的位置（从 1 开始，执行中的为 1）；不在队列中时为 0。
func (q *queue) position(id string) int {
	q.mu.Lock()
	defer q.mu.Unlock()
	d, ok := q.domain[id]
	if !ok {
		return 0
	}
	if q.active[d] == id {
		return 1
	}
	pos := 0
	if _, busy := q.active[d]; busy {
		pos = 1
	}
	for i, w := range q.waiting[d] {
		if w == id {
			return pos + i + 1
		}
	}
	return 0
}

// setActive 直接把执行登记为冲突域中执行中的那个（恢复时使用）。
func (q *queue) setActive(domain, id string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.domain[id] = domain
	q.active[domain] = id
}

// next 返回可以开始的执行：冲突域空闲、队首；并把它标为执行中。limit 是同时执行的上限。
func (q *queue) next(limit int) []string {
	q.mu.Lock()
	defer q.mu.Unlock()
	var out []string
	domains := make([]string, 0, len(q.waiting))
	for d := range q.waiting {
		domains = append(domains, d)
	}
	sort.Strings(domains)
	for _, d := range domains {
		if len(q.active) >= limit {
			break
		}
		if _, busy := q.active[d]; busy || len(q.waiting[d]) == 0 {
			continue
		}
		id := q.waiting[d][0]
		q.waiting[d] = q.waiting[d][1:]
		if len(q.waiting[d]) == 0 {
			delete(q.waiting, d)
		}
		q.active[d] = id
		out = append(out, id)
	}
	return out
}

// done 把执行移出队列。
func (q *queue) done(id string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	d, ok := q.domain[id]
	if !ok {
		return
	}
	delete(q.domain, id)
	if q.active[d] == id {
		delete(q.active, d)
	}
	w := q.waiting[d]
	for i, x := range w {
		if x == id {
			q.waiting[d] = append(w[:i:i], w[i+1:]...)
			break
		}
	}
	if len(q.waiting[d]) == 0 {
		delete(q.waiting, d)
	}
}

func (q *queue) depth() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	n := 0
	for _, w := range q.waiting {
		n += len(w)
	}
	return n
}

// snapshot 返回心跳中上报的排队情况。
func (q *queue) snapshot() []tunnel.QueueDomain {
	q.mu.Lock()
	defer q.mu.Unlock()
	seen := map[string]*tunnel.QueueDomain{}
	for d, id := range q.active {
		seen[d] = &tunnel.QueueDomain{ConflictDomain: d, ActiveExecutionID: id, Queued: []string{}}
	}
	for d, w := range q.waiting {
		if seen[d] == nil {
			seen[d] = &tunnel.QueueDomain{ConflictDomain: d, Queued: []string{}}
		}
		seen[d].Queued = append(seen[d].Queued, w...)
	}
	out := make([]tunnel.QueueDomain, 0, len(seen))
	for _, v := range seen {
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ConflictDomain < out[j].ConflictDomain })
	return out
}
