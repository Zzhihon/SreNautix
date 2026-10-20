// Package health 找出集群中当前不健康的对象，供中心的集群状态检测器使用（contract/gateway/v1/reader.openapi.yaml 的
// ReaderHealth，ADR 0035）。reader 只判断"现在是否不健康"与进入该状态的时间，不判断阈值；阈值、去重与合成告警都在中心。
// 判定只读 informer 缓存中的对象，不额外请求 apiserver。
package health

import (
	"fmt"
	"sort"
	"sync"
	"time"
	"unicode/utf8"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/Zzhihon/SreNautix/internal/spoke/reader/topology"
)

// 状态。
const (
	PodPending     = "pod_pending"
	PodInit        = "pod_init"
	CrashLoop      = "crash_loop"
	RolloutStalled = "rollout_stalled"
	PDBBlocking    = "pdb_blocking"
	JobFailed      = "job_failed"
)

// MaxObjects 是一次上报的对象上限；超出时只上报前 MaxObjects 个，complete 为 false。
const MaxObjects = 2000

const (
	maxReason  = 256
	maxMessage = 1024
)

// Details 是按状态可选的细节。
type Details struct {
	InitContainer      string `json:"init_container,omitempty"`
	Container          string `json:"container,omitempty"`
	Restarts           *int32 `json:"restarts,omitempty"`
	Desired            *int32 `json:"desired,omitempty"`
	Updated            *int32 `json:"updated,omitempty"`
	Ready              *int32 `json:"ready,omitempty"`
	Available          *int32 `json:"available,omitempty"`
	DisruptionsAllowed *int32 `json:"disruptions_allowed,omitempty"`
	ExpectedPods       *int32 `json:"expected_pods,omitempty"`
	CurrentHealthy     *int32 `json:"current_healthy,omitempty"`
	DesiredHealthy     *int32 `json:"desired_healthy,omitempty"`
}

// Object 是一个当前不健康的对象（契约的 ObjectHealth）。
type Object struct {
	Key       string    `json:"key"`
	Kind      string    `json:"kind"`
	Namespace string    `json:"namespace"`
	Name      string    `json:"name"`
	UID       string    `json:"uid"`
	State     string    `json:"state"`
	Since     time.Time `json:"since"`
	Reason    string    `json:"reason"`
	Message   string    `json:"message"`
	Owner     *string   `json:"owner"`
	Targets   []string  `json:"targets,omitempty"`
	Details   *Details  `json:"details,omitempty"`
}

// Report 是一次上报（契约的 ReaderHealth）。
type Report struct {
	ReaderID   string    `json:"reader_id"`
	ObservedAt time.Time `json:"observed_at"`
	Complete   bool      `json:"complete"`
	Objects    []Object  `json:"objects"`
}

// Source 是判定所需的 informer 缓存。
type Source interface {
	topology.Lookup
	ListPods() []*corev1.Pod
	ListDeployments() []*appsv1.Deployment
	ListStatefulSets() []*appsv1.StatefulSet
	ListDaemonSets() []*appsv1.DaemonSet
	ListJobs() []*batchv1.Job
	ListPDBs() []*policyv1.PodDisruptionBudget
}

// Scanner 判定不健康的对象。没有 Kubernetes 时间可用的状态（crash_loop、按副本数判定的 rollout_stalled）以 reader 第一次看到
// 的时间为 since，记在内存中；对象恢复后清除，reader 重启后从重启时间重新计算。
type Scanner struct {
	mu        sync.Mutex
	firstSeen map[string]time.Time
	// Problems 接收无法生成组件键而跳过的对象
	Problems func([]topology.Problem)
}

// NewScanner 创建 Scanner。
func NewScanner() *Scanner { return &Scanner{firstSeen: map[string]time.Time{}} }

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}

func i32(v int32) *int32 { return &v }

type scan struct {
	src      Source
	now      time.Time
	seen     map[string]bool
	first    map[string]time.Time
	out      []Object
	problems []topology.Problem
}

// since 返回第一次看到 (state, uid) 的时间。
func (s *scan) since(state, uid string) time.Time {
	k := state + "/" + uid
	s.seen[k] = true
	t, ok := s.first[k]
	if !ok {
		t = s.now
		s.first[k] = t
	}
	return t
}

func (s *scan) add(kind string, obj metav1.Object, state string, since time.Time, reason, message string, owner *string, targets []string, d *Details) {
	key, err := topology.Key(kind, obj.GetNamespace(), obj.GetName())
	if err != nil {
		s.problems = append(s.problems, topology.KeyProblem(err))
		return
	}
	s.out = append(s.out, Object{Key: key, Kind: kind, Namespace: obj.GetNamespace(), Name: obj.GetName(), UID: string(obj.GetUID()),
		State: state, Since: since.UTC(), Reason: clip(reason, maxReason), Message: clip(message, maxMessage), Owner: owner, Targets: targets, Details: d})
}

// owner 返回 Pod 的顶层 controller 的键（Pod → ReplicaSet → Deployment、Job → CronJob、静态 Pod → Node 等）；没有 controller 时为 nil。
func (s *scan) owner(p *corev1.Pod) *string {
	self, err := topology.Key("Pod", p.Namespace, p.Name)
	if err != nil {
		return nil
	}
	root, err := topology.RootOwner(s.src, "Pod", p.Namespace, p.Name)
	if err != nil || root == self {
		return nil
	}
	return &root
}

func condition(conds []corev1.PodCondition, t corev1.PodConditionType) *corev1.PodCondition {
	for i := range conds {
		if conds[i].Type == t {
			return &conds[i]
		}
	}
	return nil
}

// initDone 表示 init 容器都已完成：正常退出，或者是已就绪的边车（restartPolicy Always）。
func initDone(p *corev1.Pod) (bool, *corev1.ContainerStatus) {
	if len(p.Spec.InitContainers) == 0 {
		return true, nil
	}
	byName := map[string]*corev1.ContainerStatus{}
	for i := range p.Status.InitContainerStatuses {
		byName[p.Status.InitContainerStatuses[i].Name] = &p.Status.InitContainerStatuses[i]
	}
	for _, c := range p.Spec.InitContainers {
		st := byName[c.Name]
		if st == nil {
			return false, &corev1.ContainerStatus{Name: c.Name}
		}
		sidecar := c.RestartPolicy != nil && *c.RestartPolicy == corev1.ContainerRestartPolicyAlways
		if sidecar && st.Ready {
			continue
		}
		if t := st.State.Terminated; t != nil && t.ExitCode == 0 && !sidecar {
			continue
		}
		return false, st
	}
	return true, nil
}

func waiting(st *corev1.ContainerStatus) (string, string) {
	if st != nil && st.State.Waiting != nil {
		return st.State.Waiting.Reason, st.State.Waiting.Message
	}
	if st != nil && st.State.Terminated != nil {
		return st.State.Terminated.Reason, st.State.Terminated.Message
	}
	return "", ""
}

func (s *scan) pod(p *corev1.Pod) {
	if p.DeletionTimestamp != nil {
		return
	}
	owner := s.owner(p)
	all := append(append([]corev1.ContainerStatus{}, p.Status.InitContainerStatuses...), p.Status.ContainerStatuses...)
	for i := range all {
		st := &all[i]
		if st.State.Waiting != nil && st.State.Waiting.Reason == "CrashLoopBackOff" {
			s.add("Pod", p, CrashLoop, s.since(CrashLoop, string(p.UID)), "CrashLoopBackOff", st.State.Waiting.Message, owner, nil,
				&Details{Container: st.Name, Restarts: i32(st.RestartCount)})
			break
		}
	}
	if p.Status.Phase != corev1.PodPending {
		return
	}
	created := p.CreationTimestamp.UTC()
	done, stuck := initDone(p)
	if !done {
		since := created
		if c := condition(p.Status.Conditions, corev1.PodInitialized); c != nil && c.Status == corev1.ConditionFalse && c.LastTransitionTime.UTC().After(since) {
			since = c.LastTransitionTime.UTC()
		}
		reason, msg := waiting(stuck)
		if reason == "" {
			reason = "PodInitializing"
		}
		s.add("Pod", p, PodInit, since, reason, msg, owner, nil, &Details{InitContainer: stuck.Name})
		return
	}
	since := created
	reason, msg := "", ""
	if c := condition(p.Status.Conditions, corev1.PodScheduled); c != nil && c.Status == corev1.ConditionFalse {
		since, reason, msg = c.LastTransitionTime.UTC(), c.Reason, c.Message
	}
	var container string
	if reason == "" {
		for i := range p.Status.ContainerStatuses {
			st := &p.Status.ContainerStatuses[i]
			if st.State.Waiting != nil {
				reason, msg, container = st.State.Waiting.Reason, st.State.Waiting.Message, st.Name
				break
			}
		}
	}
	var d *Details
	if container != "" {
		d = &Details{Container: container}
	}
	s.add("Pod", p, PodPending, since, reason, msg, owner, nil, d)
}

func replicas(r *int32) int32 {
	if r == nil {
		return 1
	}
	return *r
}

func (s *scan) deployment(d *appsv1.Deployment) {
	if d.DeletionTimestamp != nil {
		return
	}
	want := replicas(d.Spec.Replicas)
	det := &Details{Desired: i32(want), Updated: i32(d.Status.UpdatedReplicas), Ready: i32(d.Status.ReadyReplicas), Available: i32(d.Status.AvailableReplicas)}
	for _, c := range d.Status.Conditions {
		if c.Type == appsv1.DeploymentProgressing && c.Reason == "ProgressDeadlineExceeded" {
			s.add("Deployment", d, RolloutStalled, c.LastTransitionTime.UTC(), c.Reason, c.Message, nil, nil, det)
			return
		}
	}
	if d.Status.UpdatedReplicas < want || d.Status.AvailableReplicas < want {
		s.add("Deployment", d, RolloutStalled, s.since(RolloutStalled, string(d.UID)), "", "", nil, nil, det)
	}
}

func (s *scan) statefulSet(st *appsv1.StatefulSet) {
	if st.DeletionTimestamp != nil {
		return
	}
	want := replicas(st.Spec.Replicas)
	rolling := st.Spec.UpdateStrategy.Type != appsv1.OnDeleteStatefulSetStrategyType
	if (rolling && st.Status.UpdateRevision != "" && st.Status.CurrentRevision != st.Status.UpdateRevision) || st.Status.ReadyReplicas < want {
		s.add("StatefulSet", st, RolloutStalled, s.since(RolloutStalled, string(st.UID)), "", "", nil, nil,
			&Details{Desired: i32(want), Updated: i32(st.Status.UpdatedReplicas), Ready: i32(st.Status.ReadyReplicas), Available: i32(st.Status.AvailableReplicas)})
	}
}

func (s *scan) daemonSet(ds *appsv1.DaemonSet) {
	if ds.DeletionTimestamp != nil {
		return
	}
	want := ds.Status.DesiredNumberScheduled
	if ds.Status.UpdatedNumberScheduled < want || ds.Status.NumberAvailable < want {
		s.add("DaemonSet", ds, RolloutStalled, s.since(RolloutStalled, string(ds.UID)), "", "", nil, nil,
			&Details{Desired: i32(want), Updated: i32(ds.Status.UpdatedNumberScheduled), Ready: i32(ds.Status.NumberReady), Available: i32(ds.Status.NumberAvailable)})
	}
}

func (s *scan) job(j *batchv1.Job) {
	for _, c := range j.Status.Conditions {
		if c.Type == batchv1.JobFailed && c.Status == corev1.ConditionTrue {
			s.add("Job", j, JobFailed, c.LastTransitionTime.UTC(), c.Reason, c.Message, nil, nil, nil)
			return
		}
	}
}

func (s *scan) pdb(p *policyv1.PodDisruptionBudget) {
	if p.Status.DisruptionsAllowed != 0 || p.Status.ExpectedPods <= 0 {
		return
	}
	since := s.now
	reason, msg := "", ""
	found := false
	for _, c := range p.Status.Conditions {
		if c.Type == policyv1.DisruptionAllowedCondition && c.Status == metav1.ConditionFalse {
			since, reason, msg, found = c.LastTransitionTime.UTC(), c.Reason, c.Message, true
		}
	}
	if !found {
		since = s.since(PDBBlocking, string(p.UID))
	}
	var targets []string
	if sel, err := metav1.LabelSelectorAsSelector(p.Spec.Selector); err == nil {
		set := map[string]bool{}
		for _, pod := range s.src.Pods(p.Namespace, sel) {
			if o := s.owner(pod); o != nil {
				set[*o] = true
			} else if k, err := topology.Key("Pod", pod.Namespace, pod.Name); err == nil {
				set[k] = true
			}
		}
		for k := range set {
			targets = append(targets, k)
		}
		sort.Strings(targets)
	}
	if targets == nil {
		targets = []string{}
	}
	s.add("PodDisruptionBudget", p, PDBBlocking, since, reason, msg, nil, targets, &Details{DisruptionsAllowed: i32(p.Status.DisruptionsAllowed),
		ExpectedPods: i32(p.Status.ExpectedPods), CurrentHealthy: i32(p.Status.CurrentHealthy), DesiredHealthy: i32(p.Status.DesiredHealthy)})
}

// Scan 返回当前不健康的对象（按键与状态排序）与是否完整（没有超过 MaxObjects）。now 是 apiserver 参考时间。
func (sc *Scanner) Scan(src Source, now time.Time) ([]Object, bool) {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	s := &scan{src: src, now: now.UTC(), seen: map[string]bool{}, first: sc.firstSeen}
	for _, p := range src.ListPods() {
		s.pod(p)
	}
	for _, d := range src.ListDeployments() {
		s.deployment(d)
	}
	for _, st := range src.ListStatefulSets() {
		s.statefulSet(st)
	}
	for _, ds := range src.ListDaemonSets() {
		s.daemonSet(ds)
	}
	for _, j := range src.ListJobs() {
		s.job(j)
	}
	for _, p := range src.ListPDBs() {
		s.pdb(p)
	}
	for k := range sc.firstSeen {
		if !s.seen[k] {
			delete(sc.firstSeen, k)
		}
	}
	if len(s.problems) > 0 && sc.Problems != nil {
		sc.Problems(s.problems)
	}
	sort.Slice(s.out, func(i, j int) bool {
		if s.out[i].Key != s.out[j].Key {
			return s.out[i].Key < s.out[j].Key
		}
		return s.out[i].State < s.out[j].State
	})
	if len(s.out) > MaxObjects {
		return s.out[:MaxObjects], false
	}
	if s.out == nil {
		s.out = []Object{}
	}
	return s.out, true
}

// String 便于日志与测试输出。
func (o Object) String() string {
	return fmt.Sprintf("%s %s since %s (%s)", o.Key, o.State, o.Since.Format(time.RFC3339), o.Reason)
}
