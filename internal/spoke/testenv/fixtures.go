package testenv

import (
	"context"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/utils/ptr"
)

// 固定版本 CRD 中的资源。
var (
	ClusterGVR       = schema.GroupVersionResource{Group: "postgresql.cnpg.io", Version: "v1", Resource: "clusters"}
	ApplicationGVR   = schema.GroupVersionResource{Group: "argoproj.io", Version: "v1alpha1", Resource: "applications"}
	WorkflowGVR      = schema.GroupVersionResource{Group: "argoproj.io", Version: "v1alpha1", Resource: "workflows"}
	TemplateGVR      = schema.GroupVersionResource{Group: "argoproj.io", Version: "v1alpha1", Resource: "workflowtemplates"}
	KustomizationGVR = schema.GroupVersionResource{Group: "kustomize.toolkit.fluxcd.io", Version: "v1", Resource: "kustomizations"}
	HelmReleaseGVR   = schema.GroupVersionResource{Group: "helm.toolkit.fluxcd.io", Version: "v2", Resource: "helmreleases"}
)

// Fixtures 在 envtest 中创建对象，并按控制器的方式写入 status（envtest 不运行任何控制器）。
type Fixtures struct {
	T    testing.TB
	Core kubernetes.Interface
	Dyn  dynamic.Interface
}

// Fixtures 返回以管理员身份创建对象的 Fixtures。
func (e *Env) Fixtures(t testing.TB) *Fixtures { return &Fixtures{T: t, Core: e.Core, Dyn: e.Dyn} }

var bg = context.Background()

func (f *Fixtures) must(err error) {
	f.T.Helper()
	if err != nil {
		f.T.Fatal(err)
	}
}

func containers() []corev1.Container {
	return []corev1.Container{{Name: "main", Image: "registry.example/app@sha256:0000000000000000000000000000000000000000000000000000000000000000"}}
}

// Deployment 创建 Deployment 并写入 rollout 已完成、全部就绪的 status。
func (f *Fixtures) Deployment(ns, name string, replicas int32) *appsv1.Deployment {
	f.T.Helper()
	labels := map[string]string{"app": name}
	d, err := f.Core.AppsV1().Deployments(ns).Create(bg, &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec: appsv1.DeploymentSpec{
			Replicas: ptr.To(replicas),
			Selector: &metav1.LabelSelector{MatchLabels: labels},
			Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: labels}, Spec: corev1.PodSpec{Containers: containers()}},
		},
	}, metav1.CreateOptions{})
	f.must(err)
	return f.SetDeploymentStatus(d, replicas, replicas)
}

// SetDeploymentStatus 写入 rollout 已完成的状态，ready 为就绪副本数。
func (f *Fixtures) SetDeploymentStatus(d *appsv1.Deployment, replicas, ready int32) *appsv1.Deployment {
	f.T.Helper()
	cur, err := f.Core.AppsV1().Deployments(d.Namespace).Get(bg, d.Name, metav1.GetOptions{})
	f.must(err)
	cur.Status = appsv1.DeploymentStatus{ObservedGeneration: cur.Generation, Replicas: replicas, UpdatedReplicas: replicas,
		ReadyReplicas: ready, AvailableReplicas: ready}
	out, err := f.Core.AppsV1().Deployments(d.Namespace).UpdateStatus(bg, cur, metav1.UpdateOptions{})
	f.must(err)
	return out
}

// ReplicaSet 创建 Deployment 的 ReplicaSet。
func (f *Fixtures) ReplicaSet(d *appsv1.Deployment) *appsv1.ReplicaSet {
	f.T.Helper()
	rs, err := f.Core.AppsV1().ReplicaSets(d.Namespace).Create(bg, &appsv1.ReplicaSet{
		ObjectMeta: metav1.ObjectMeta{Name: d.Name + "-5d8f7c9b6", Namespace: d.Namespace, Labels: d.Spec.Template.Labels,
			OwnerReferences: []metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "Deployment", Name: d.Name, UID: d.UID, Controller: ptr.To(true)}}},
		Spec: appsv1.ReplicaSetSpec{Replicas: d.Spec.Replicas, Selector: d.Spec.Selector, Template: d.Spec.Template},
	}, metav1.CreateOptions{})
	f.must(err)
	return rs
}

// Pod 创建属于 rs 的 Pod 并写入状态：容器在运行，ready=false 时 Ready 条件 15 分钟前变为 False。
func (f *Fixtures) Pod(rs *appsv1.ReplicaSet, name string, ready bool) *corev1.Pod {
	f.T.Helper()
	return f.OwnedPod(rs.Namespace, name, rs.Spec.Template.Labels,
		&metav1.OwnerReference{APIVersion: "apps/v1", Kind: "ReplicaSet", Name: rs.Name, UID: rs.UID, Controller: ptr.To(true)}, ready)
}

// OwnedPod 创建带属主的 Pod；owner 为 nil 时是裸 Pod。
func (f *Fixtures) OwnedPod(ns, name string, labels map[string]string, owner *metav1.OwnerReference, ready bool) *corev1.Pod {
	f.T.Helper()
	meta := metav1.ObjectMeta{Name: name, Namespace: ns, Labels: labels}
	if owner != nil {
		meta.OwnerReferences = []metav1.OwnerReference{*owner}
	}
	p, err := f.Core.CoreV1().Pods(ns).Create(bg, &corev1.Pod{ObjectMeta: meta, Spec: corev1.PodSpec{Containers: containers(), NodeName: ""}}, metav1.CreateOptions{})
	f.must(err)
	return f.SetPodReady(p, ready)
}

// SetPodReady 写入 Pod 的就绪状态。
func (f *Fixtures) SetPodReady(p *corev1.Pod, ready bool) *corev1.Pod {
	f.T.Helper()
	cur, err := f.Core.CoreV1().Pods(p.Namespace).Get(bg, p.Name, metav1.GetOptions{})
	f.must(err)
	status := corev1.ConditionFalse
	if ready {
		status = corev1.ConditionTrue
	}
	at := metav1.NewTime(time.Now().Add(-15 * time.Minute).Truncate(time.Second))
	cur.Status = corev1.PodStatus{
		Phase:      corev1.PodRunning,
		Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: status, LastTransitionTime: at}},
		ContainerStatuses: []corev1.ContainerStatus{{Name: "main", Ready: ready, Image: containers()[0].Image,
			State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: at}}}},
	}
	out, err := f.Core.CoreV1().Pods(p.Namespace).UpdateStatus(bg, cur, metav1.UpdateOptions{})
	f.must(err)
	return out
}

// PDB 创建 PodDisruptionBudget 并按 disruption 控制器的方式写入 status。
func (f *Fixtures) PDB(ns, name string, selector map[string]string, allowed, healthy, desired, expected int32) *policyv1.PodDisruptionBudget {
	f.T.Helper()
	minAvail := intstr.FromInt32(desired)
	pdb, err := f.Core.PolicyV1().PodDisruptionBudgets(ns).Create(bg, &policyv1.PodDisruptionBudget{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec:       policyv1.PodDisruptionBudgetSpec{MinAvailable: &minAvail, Selector: &metav1.LabelSelector{MatchLabels: selector}},
	}, metav1.CreateOptions{})
	f.must(err)
	pdb.Status = policyv1.PodDisruptionBudgetStatus{ObservedGeneration: pdb.Generation, DisruptionsAllowed: allowed,
		CurrentHealthy: healthy, DesiredHealthy: desired, ExpectedPods: expected}
	out, err := f.Core.PolicyV1().PodDisruptionBudgets(ns).UpdateStatus(bg, pdb, metav1.UpdateOptions{})
	f.must(err)
	return out
}

// StatefulSet 创建 StatefulSet 并写入全部就绪的 status。
func (f *Fixtures) StatefulSet(ns, name string, replicas int32) *appsv1.StatefulSet {
	f.T.Helper()
	labels := map[string]string{"app": name}
	s, err := f.Core.AppsV1().StatefulSets(ns).Create(bg, &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec: appsv1.StatefulSetSpec{
			Replicas: ptr.To(replicas), ServiceName: name,
			Selector: &metav1.LabelSelector{MatchLabels: labels},
			Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: labels}, Spec: corev1.PodSpec{Containers: containers()}},
		},
	}, metav1.CreateOptions{})
	f.must(err)
	s.Status = appsv1.StatefulSetStatus{ObservedGeneration: s.Generation, Replicas: replicas, ReadyReplicas: replicas,
		CurrentReplicas: replicas, UpdatedReplicas: replicas, AvailableReplicas: replicas, CurrentRevision: name + "-1", UpdateRevision: name + "-1"}
	out, err := f.Core.AppsV1().StatefulSets(ns).UpdateStatus(bg, s, metav1.UpdateOptions{})
	f.must(err)
	return out
}

// HPA 创建以 Deployment 为目标的 HorizontalPodAutoscaler。
func (f *Fixtures) HPA(ns, name, deployment string, min, max int32) *autoscalingv2.HorizontalPodAutoscaler {
	f.T.Helper()
	h, err := f.Core.AutoscalingV2().HorizontalPodAutoscalers(ns).Create(bg, &autoscalingv2.HorizontalPodAutoscaler{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec: autoscalingv2.HorizontalPodAutoscalerSpec{
			ScaleTargetRef: autoscalingv2.CrossVersionObjectReference{APIVersion: "apps/v1", Kind: "Deployment", Name: deployment},
			MinReplicas:    ptr.To(min), MaxReplicas: max,
		},
	}, metav1.CreateOptions{})
	f.must(err)
	return h
}

// CronJob 创建 CronJob。
func (f *Fixtures) CronJob(ns, name string) *batchv1.CronJob {
	f.T.Helper()
	c, err := f.Core.BatchV1().CronJobs(ns).Create(bg, &batchv1.CronJob{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec: batchv1.CronJobSpec{Schedule: "*/5 * * * *", JobTemplate: batchv1.JobTemplateSpec{Spec: batchv1.JobSpec{
			Template: corev1.PodTemplateSpec{Spec: corev1.PodSpec{Containers: containers(), RestartPolicy: corev1.RestartPolicyNever}}}}},
	}, metav1.CreateOptions{})
	f.must(err)
	return c
}

// Node 创建节点并写入状态；controlPlane 为 true 时带控制面角色标签。
func (f *Fixtures) Node(name string, controlPlane, ready bool) *corev1.Node {
	f.T.Helper()
	labels := map[string]string{"kubernetes.io/hostname": name, "node-role.kubernetes.io/worker": ""}
	if controlPlane {
		labels = map[string]string{"kubernetes.io/hostname": name, "node-role.kubernetes.io/control-plane": ""}
	}
	n, err := f.Core.CoreV1().Nodes().Create(bg, &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: name, Labels: labels}}, metav1.CreateOptions{})
	f.must(err)
	status := corev1.ConditionFalse
	if ready {
		status = corev1.ConditionTrue
	}
	n.Status.Conditions = []corev1.NodeCondition{
		{Type: corev1.NodeReady, Status: status, LastHeartbeatTime: metav1.Now(), LastTransitionTime: metav1.Now()},
		{Type: corev1.NodeMemoryPressure, Status: corev1.ConditionFalse},
		{Type: corev1.NodeDiskPressure, Status: corev1.ConditionFalse},
		{Type: corev1.NodePIDPressure, Status: corev1.ConditionFalse},
	}
	out, err := f.Core.CoreV1().Nodes().UpdateStatus(bg, n, metav1.UpdateOptions{})
	f.must(err)
	return out
}

// CNPGCluster 创建 Cluster 与实例 Pod（标签同 CNPG），status 为健康的主备状态。
func (f *Fixtures) CNPGCluster(ns, name, primary string, instances []string) *unstructured.Unstructured {
	f.T.Helper()
	c, err := f.Dyn.Resource(ClusterGVR).Namespace(ns).Create(bg, &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "postgresql.cnpg.io/v1", "kind": "Cluster",
		"metadata": map[string]any{"name": name, "namespace": ns},
		"spec":     map[string]any{"instances": int64(len(instances)), "storage": map[string]any{"size": "1Gi"}},
	}}, metav1.CreateOptions{})
	f.must(err)
	now := time.Now().UTC().Format(time.RFC3339)
	names := make([]any, len(instances))
	for i, n := range instances {
		names[i] = n
	}
	c.Object["status"] = map[string]any{
		"instanceNames": names, "instances": int64(len(instances)), "readyInstances": int64(len(instances)),
		"currentPrimary": primary, "targetPrimary": primary, "phase": "Cluster in healthy state",
		"conditions": []any{map[string]any{"type": "Ready", "status": "True", "reason": "ClusterIsReady", "message": "Cluster is Ready", "lastTransitionTime": now}},
	}
	out, err := f.Dyn.Resource(ClusterGVR).Namespace(ns).UpdateStatus(bg, c, metav1.UpdateOptions{})
	f.must(err)
	owner := &metav1.OwnerReference{APIVersion: "postgresql.cnpg.io/v1", Kind: "Cluster", Name: name, UID: c.GetUID(), Controller: ptr.To(true)}
	for _, inst := range instances {
		role := "replica"
		if inst == primary {
			role = "primary"
		}
		f.OwnedPod(ns, inst, map[string]string{"cnpg.io/cluster": name, "cnpg.io/instanceName": inst,
			"cnpg.io/instanceRole": role, "cnpg.io/podRole": "instance"}, owner, true)
	}
	return out
}

// Application 创建 Argo CD Application；automated 为 true 时带自动同步；running 为 true 时带一个 20 分钟前开始的运行中操作。
func (f *Fixtures) Application(ns, name, revision string, automated, running bool) *unstructured.Unstructured {
	f.T.Helper()
	spec := map[string]any{
		"project":     "default",
		"source":      map[string]any{"repoURL": "https://git.example/infra.git", "path": "apps/" + name, "targetRevision": "main"},
		"destination": map[string]any{"server": "https://kubernetes.default.svc", "namespace": name},
	}
	if automated {
		spec["syncPolicy"] = map[string]any{"automated": map[string]any{"prune": false, "selfHeal": true}}
	}
	obj := map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
		"metadata": map[string]any{"name": name, "namespace": ns},
		"spec":     spec,
		"status": map[string]any{
			"sync":   map[string]any{"status": "OutOfSync", "revision": revision},
			"health": map[string]any{"status": "Healthy"},
			"operationState": map[string]any{"phase": "Succeeded", "startedAt": time.Now().Add(-48 * time.Hour).UTC().Format(time.RFC3339),
				"operation":  map[string]any{"sync": map[string]any{"revision": "fedcba9876543210fedcba9876543210fedcba98"}},
				"syncResult": map[string]any{"revision": "fedcba9876543210fedcba9876543210fedcba98"}},
		},
	}
	if running {
		obj["operation"] = map[string]any{"sync": map[string]any{"revision": revision}, "initiatedBy": map[string]any{"username": "admin"}}
		obj["status"].(map[string]any)["operationState"] = map[string]any{"phase": "Running",
			"startedAt": time.Now().Add(-20 * time.Minute).UTC().Format(time.RFC3339),
			"operation": map[string]any{"sync": map[string]any{"revision": revision}}}
	}
	out, err := f.Dyn.Resource(ApplicationGVR).Namespace(ns).Create(bg, &unstructured.Unstructured{Object: obj}, metav1.CreateOptions{})
	f.must(err)
	return out
}

// Kustomization 创建 Flux Kustomization。
func (f *Fixtures) Kustomization(ns, name string) *unstructured.Unstructured {
	f.T.Helper()
	out, err := f.Dyn.Resource(KustomizationGVR).Namespace(ns).Create(bg, &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "kustomize.toolkit.fluxcd.io/v1", "kind": "Kustomization",
		"metadata": map[string]any{"name": name, "namespace": ns},
		"spec": map[string]any{"interval": "10m", "path": "./apps/" + name, "prune": true,
			"sourceRef": map[string]any{"kind": "GitRepository", "name": "infra"}},
	}}, metav1.CreateOptions{})
	f.must(err)
	return out
}

// HelmRelease 创建 Flux HelmRelease。
func (f *Fixtures) HelmRelease(ns, name string) *unstructured.Unstructured {
	f.T.Helper()
	out, err := f.Dyn.Resource(HelmReleaseGVR).Namespace(ns).Create(bg, &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "helm.toolkit.fluxcd.io/v2", "kind": "HelmRelease",
		"metadata": map[string]any{"name": name, "namespace": ns},
		"spec": map[string]any{"interval": "10m", "chart": map[string]any{"spec": map[string]any{"chart": name,
			"sourceRef": map[string]any{"kind": "HelmRepository", "name": "charts"}}}},
	}}, metav1.CreateOptions{})
	f.must(err)
	return out
}

// WorkflowTemplate 创建 WorkflowTemplate。
func (f *Fixtures) WorkflowTemplate(ns, name, serviceAccount string, params []string) *unstructured.Unstructured {
	f.T.Helper()
	var ps []any
	for _, p := range params {
		ps = append(ps, map[string]any{"name": p})
	}
	out, err := f.Dyn.Resource(TemplateGVR).Namespace(ns).Create(bg, &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "WorkflowTemplate",
		"metadata": map[string]any{"name": name, "namespace": ns},
		"spec": map[string]any{
			"entrypoint": "main", "serviceAccountName": serviceAccount, "activeDeadlineSeconds": int64(600),
			"arguments": map[string]any{"parameters": ps},
			"templates": []any{map[string]any{"name": "main", "container": map[string]any{
				"image": "registry.example/tool@sha256:1111111111111111111111111111111111111111111111111111111111111111",
				"args":  []any{"run"}}}},
		},
	}}, metav1.CreateOptions{})
	f.must(err)
	return out
}

// SetStatus 按控制器的方式改写自定义资源的 status。
func (f *Fixtures) SetStatus(gvr schema.GroupVersionResource, ns, name string, status map[string]any) *unstructured.Unstructured {
	f.T.Helper()
	cur, err := f.Dyn.Resource(gvr).Namespace(ns).Get(bg, name, metav1.GetOptions{})
	f.must(err)
	cur.Object["status"] = status
	out, err := f.Dyn.Resource(gvr).Namespace(ns).UpdateStatus(bg, cur, metav1.UpdateOptions{})
	f.must(err)
	return out
}
