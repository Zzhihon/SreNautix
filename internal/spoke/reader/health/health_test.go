package health_test

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/utils/ptr"

	"github.com/Zzhihon/SreNautix/internal/spoke/reader/clock"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/health"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/kube"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/testenv"
	"github.com/Zzhihon/SreNautix/internal/spoke/reader/topology"
)

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

var labels = map[string]string{"app": "api"}

func podSpec(init bool) corev1.PodSpec {
	s := corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Image: "x"}}}
	if init {
		s.InitContainers = []corev1.Container{{Name: "migrate", Image: "x"}}
	}
	return s
}

// 在 envtest 上按控制器与 kubelet 的方式写入 status，逐个状态核对判定、since、属主与细节；对象恢复后从结果中消失。
func TestScanUnhealthyObjects(t *testing.T) {
	cfg, _ := testenv.StartKube(t, false)
	cs := kubernetes.NewForConfigOrDie(cfg)
	c := context.Background()
	must(cs.CoreV1().Namespaces().Create(c, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "app"}}, metav1.CreateOptions{}))
	t0 := metav1.NewTime(time.Now().Add(-20 * time.Minute).UTC().Truncate(time.Second))

	dep := must(cs.AppsV1().Deployments("app").Create(c, &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Namespace: "app", Name: "api"},
		Spec: appsv1.DeploymentSpec{Replicas: ptr.To[int32](2), Selector: &metav1.LabelSelector{MatchLabels: labels},
			Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: labels}, Spec: podSpec(false)}},
	}, metav1.CreateOptions{}))
	dep.Status = appsv1.DeploymentStatus{Replicas: 2, UpdatedReplicas: 1, ReadyReplicas: 1, AvailableReplicas: 1,
		Conditions: []appsv1.DeploymentCondition{{Type: appsv1.DeploymentProgressing, Status: corev1.ConditionFalse, Reason: "ProgressDeadlineExceeded",
			Message: "ReplicaSet api-rs has timed out progressing.", LastUpdateTime: t0, LastTransitionTime: t0}}}
	must(cs.AppsV1().Deployments("app").UpdateStatus(c, dep, metav1.UpdateOptions{}))
	slow := must(cs.AppsV1().Deployments("app").Create(c, &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Namespace: "app", Name: "slow"},
		Spec: appsv1.DeploymentSpec{Replicas: ptr.To[int32](3), Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "slow"}},
			Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "slow"}}, Spec: podSpec(false)}},
	}, metav1.CreateOptions{}))
	slow.Status = appsv1.DeploymentStatus{Replicas: 3, UpdatedReplicas: 3, ReadyReplicas: 2, AvailableReplicas: 2}
	must(cs.AppsV1().Deployments("app").UpdateStatus(c, slow, metav1.UpdateOptions{}))
	rs := must(cs.AppsV1().ReplicaSets("app").Create(c, &appsv1.ReplicaSet{
		ObjectMeta: metav1.ObjectMeta{Namespace: "app", Name: "api-rs", OwnerReferences: []metav1.OwnerReference{
			{APIVersion: "apps/v1", Kind: "Deployment", Name: "api", UID: dep.UID, Controller: ptr.To(true)}}},
		Spec: appsv1.ReplicaSetSpec{Selector: &metav1.LabelSelector{MatchLabels: labels},
			Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: labels}, Spec: podSpec(false)}},
	}, metav1.CreateOptions{}))
	ownedPod := func(name string, init bool) *corev1.Pod {
		return must(cs.CoreV1().Pods("app").Create(c, &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Namespace: "app", Name: name, Labels: labels, OwnerReferences: []metav1.OwnerReference{
				{APIVersion: "apps/v1", Kind: "ReplicaSet", Name: "api-rs", UID: rs.UID, Controller: ptr.To(true)}}},
			Spec: podSpec(init),
		}, metav1.CreateOptions{}))
	}
	crash := ownedPod("api-crash", false)
	crash.Status = corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{{Name: "app", RestartCount: 7,
		State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff", Message: "back-off 5m0s restarting failed container"}}}}}
	must(cs.CoreV1().Pods("app").UpdateStatus(c, crash, metav1.UpdateOptions{}))
	initPod := ownedPod("api-init", true)
	initPod.Status = corev1.PodStatus{Phase: corev1.PodPending,
		Conditions:            []corev1.PodCondition{{Type: corev1.PodInitialized, Status: corev1.ConditionFalse, Reason: "ContainersNotInitialized", LastTransitionTime: t0}},
		InitContainerStatuses: []corev1.ContainerStatus{{Name: "migrate", State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: t0}}}}}
	must(cs.CoreV1().Pods("app").UpdateStatus(c, initPod, metav1.UpdateOptions{}))
	pending := ownedPod("api-pending", false)
	pending.Status = corev1.PodStatus{Phase: corev1.PodPending, Conditions: []corev1.PodCondition{{Type: corev1.PodScheduled, Status: corev1.ConditionFalse,
		Reason: "Unschedulable", Message: "0/3 nodes are available: 3 Insufficient memory.", LastTransitionTime: t0}}}
	must(cs.CoreV1().Pods("app").UpdateStatus(c, pending, metav1.UpdateOptions{}))
	running := ownedPod("api-ok", false)
	running.Status = corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{{Name: "app", Ready: true,
		State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: t0}}}}}
	must(cs.CoreV1().Pods("app").UpdateStatus(c, running, metav1.UpdateOptions{}))

	job := must(cs.BatchV1().Jobs("app").Create(c, &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{Namespace: "app", Name: "migrate"},
		Spec: batchv1.JobSpec{Template: corev1.PodTemplateSpec{Spec: corev1.PodSpec{RestartPolicy: corev1.RestartPolicyNever,
			Containers: []corev1.Container{{Name: "m", Image: "x"}}}}},
	}, metav1.CreateOptions{}))
	job.Status = batchv1.JobStatus{Failed: 6, StartTime: &t0, Conditions: []batchv1.JobCondition{
		{Type: batchv1.JobFailureTarget, Status: corev1.ConditionTrue, Reason: "BackoffLimitExceeded", LastTransitionTime: t0},
		{Type: batchv1.JobFailed, Status: corev1.ConditionTrue, Reason: "BackoffLimitExceeded", Message: "Job has reached the specified backoff limit", LastTransitionTime: t0}}}
	must(cs.BatchV1().Jobs("app").UpdateStatus(c, job, metav1.UpdateOptions{}))

	pdb := must(cs.PolicyV1().PodDisruptionBudgets("app").Create(c, &policyv1.PodDisruptionBudget{
		ObjectMeta: metav1.ObjectMeta{Namespace: "app", Name: "api"},
		Spec:       policyv1.PodDisruptionBudgetSpec{MinAvailable: ptr.To(intstr.FromInt32(4)), Selector: &metav1.LabelSelector{MatchLabels: labels}},
	}, metav1.CreateOptions{}))
	pdb.Status = policyv1.PodDisruptionBudgetStatus{ObservedGeneration: pdb.Generation, DisruptionsAllowed: 0, CurrentHealthy: 1, DesiredHealthy: 4, ExpectedPods: 4,
		Conditions: []metav1.Condition{{Type: policyv1.DisruptionAllowedCondition, Status: metav1.ConditionFalse, Reason: policyv1.InsufficientPodsReason,
			Message: "", LastTransitionTime: t0, ObservedGeneration: pdb.Generation}}}
	must(cs.PolicyV1().PodDisruptionBudgets("app").UpdateStatus(c, pdb, metav1.UpdateOptions{}))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reg := prometheus.NewRegistry()
	httpc := must(rest.HTTPClientFor(cfg))
	w := kube.New(cs, nil, topology.NewStore("c1"), clock.New(httpc, cfg.Host, reg), func([]topology.Event) {}, reg,
		topology.NewReporter(reg, slog.New(slog.NewTextHandler(io.Discard, nil))))
	if err := w.Start(ctx); err != nil {
		t.Fatal(err)
	}
	sc := health.NewScanner()
	byKey := func(objs []health.Object) map[string]health.Object {
		out := map[string]health.Object{}
		for _, o := range objs {
			out[o.Key+" "+o.State] = o
		}
		return out
	}
	now := time.Now()
	objs, complete := sc.Scan(w, now)
	if !complete {
		t.Fatal("scan not complete")
	}
	got := byKey(objs)
	const owner = "Deployment:app/api"
	check := func(id string, since time.Time, reason string, f func(health.Object) error) {
		t.Helper()
		o, ok := got[id]
		if !ok {
			t.Fatalf("missing %s; have %v", id, objs)
		}
		if !o.Since.Equal(since) || o.Reason != reason {
			t.Fatalf("%s: since %s reason %q, want %s %q", id, o.Since, o.Reason, since, reason)
		}
		if f != nil {
			if err := f(o); err != nil {
				t.Fatalf("%s: %v (%+v)", id, err, o)
			}
		}
	}
	ownedBy := func(o health.Object) error {
		if o.Owner == nil || *o.Owner != owner {
			return fmt.Errorf("owner %v", o.Owner)
		}
		return nil
	}
	check("Deployment:app/api rollout_stalled", t0.Time, "ProgressDeadlineExceeded", func(o health.Object) error {
		if *o.Details.Desired != 2 || *o.Details.Updated != 1 || o.Owner != nil {
			return fmt.Errorf("details %+v", o.Details)
		}
		return nil
	})
	check("Deployment:app/slow rollout_stalled", now.UTC(), "", nil)
	check("Pod:app/api-crash crash_loop", now.UTC(), "CrashLoopBackOff", func(o health.Object) error {
		if err := ownedBy(o); err != nil {
			return err
		}
		if o.Details.Container != "app" || *o.Details.Restarts != 7 {
			return fmt.Errorf("details %+v", o.Details)
		}
		return nil
	})
	// 创建时间晚于 Initialized 条件的变化时间：取较晚的创建时间
	check("Pod:app/api-init pod_init", initPod.CreationTimestamp.UTC(), "PodInitializing", func(o health.Object) error {
		if o.Details.InitContainer != "migrate" {
			return fmt.Errorf("init container %q", o.Details.InitContainer)
		}
		return ownedBy(o)
	})
	check("Pod:app/api-pending pod_pending", t0.Time, "Unschedulable", ownedBy)
	check("Job:app/migrate job_failed", t0.Time, "BackoffLimitExceeded", nil)
	check("PodDisruptionBudget:app/api pdb_blocking", t0.Time, policyv1.InsufficientPodsReason, func(o health.Object) error {
		if fmt.Sprint(o.Targets) != "["+owner+"]" || *o.Details.ExpectedPods != 4 {
			return fmt.Errorf("targets %v details %+v", o.Targets, o.Details)
		}
		return nil
	})
	if _, ok := got["Pod:app/api-ok pod_pending"]; ok || len(objs) != 7 {
		t.Fatalf("unexpected objects: %v", objs)
	}

	// 第二次扫描：第一次看到的时间保持不变
	objs, _ = sc.Scan(w, now.Add(time.Minute))
	if o := byKey(objs)["Pod:app/api-crash crash_loop"]; !o.Since.Equal(now.UTC()) {
		t.Fatalf("crash_loop since moved to %s", o.Since)
	}
	// 恢复后消失；再次进入该状态时从新的时间算起
	crash = must(cs.CoreV1().Pods("app").Get(c, "api-crash", metav1.GetOptions{}))
	crash.Status.ContainerStatuses[0].State = corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: metav1.Now()}}
	must(cs.CoreV1().Pods("app").UpdateStatus(c, crash, metav1.UpdateOptions{}))
	testenv.Eventually(t, 10*time.Second, func() error {
		objs, _ = sc.Scan(w, now.Add(2*time.Minute))
		if _, ok := byKey(objs)["Pod:app/api-crash crash_loop"]; ok {
			return fmt.Errorf("crash_loop still reported")
		}
		return nil
	})
}
