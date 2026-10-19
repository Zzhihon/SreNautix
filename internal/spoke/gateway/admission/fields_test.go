package admission

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	"sigs.k8s.io/yaml"

	"github.com/Zzhihon/SreNautix/internal/spoke/testenv"
)

// covered 要求 actual 中的每个字段都在 listed 或 allowed 中，否则准入策略会放过对该字段的修改。
func covered(t *testing.T, what string, actual, listed, allowed []string) {
	t.Helper()
	set := map[string]bool{}
	for _, f := range append(append([]string{}, listed...), allowed...) {
		set[f] = true
	}
	for _, f := range actual {
		if !set[f] {
			t.Errorf("%s: field %s is neither compared nor allowed to change", what, f)
		}
	}
}

func jsonFields(v any) []string {
	var out []string
	rt := reflect.TypeOf(v)
	for i := 0; i < rt.NumField(); i++ {
		name, _, _ := strings.Cut(rt.Field(i).Tag.Get("json"), ",")
		if name != "" && name != "-" {
			out = append(out, name)
		}
	}
	return out
}

func TestCoreFieldLists(t *testing.T) {
	covered(t, "DeploymentSpec", jsonFields(appsv1.DeploymentSpec{}), deploymentSpecFields, []string{"replicas", "paused"})
	covered(t, "StatefulSetSpec", jsonFields(appsv1.StatefulSetSpec{}), statefulSetSpecFields, []string{"replicas"})
	covered(t, "HorizontalPodAutoscalerSpec", jsonFields(autoscalingv2.HorizontalPodAutoscalerSpec{}), hpaSpecFields, []string{"minReplicas", "maxReplicas"})
	covered(t, "CronJobSpec", jsonFields(batchv1.CronJobSpec{}), cronJobSpecFields, []string{"suspend"})
	covered(t, "NodeSpec", jsonFields(corev1.NodeSpec{}), nodeSpecFields, []string{"unschedulable"})
}

func crdProps(t *testing.T, file, name string, path ...string) []string {
	t.Helper()
	for _, doc := range testenv.Docs(t, filepath.Join(testenv.Root(), "test", "crds", file)) {
		var crd apiextensionsv1.CustomResourceDefinition
		if err := yaml.Unmarshal(doc, &crd); err != nil {
			t.Fatal(err)
		}
		if crd.Name != name {
			continue
		}
		for _, v := range crd.Spec.Versions {
			if !v.Storage {
				continue
			}
			s := *v.Schema.OpenAPIV3Schema
			for _, p := range path {
				s = s.Properties[p]
			}
			var out []string
			for k := range s.Properties {
				out = append(out, k)
			}
			if len(out) == 0 {
				t.Fatalf("%s %v has no properties", name, path)
			}
			return out
		}
	}
	t.Fatalf("CRD %s not found in %s", name, file)
	return nil
}

func TestCRDFieldLists(t *testing.T) {
	covered(t, "Cluster.status", crdProps(t, "postgresql.cnpg.io_clusters.yaml", "clusters.postgresql.cnpg.io", "status"), cnpgStatusFields, cnpgPromoteFields)
	const app = "applications.argoproj.io"
	const appFile = "argoproj.io_applications.yaml"
	covered(t, "Application.spec", crdProps(t, appFile, app, "spec"), applicationSpecFields, []string{"syncPolicy"})
	covered(t, "Application.spec.syncPolicy", crdProps(t, appFile, app, "spec", "syncPolicy"), applicationSyncPolicyFields, []string{"automated"})
	covered(t, "Application.spec.syncPolicy.automated", crdProps(t, appFile, app, "spec", "syncPolicy", "automated"), applicationAutomatedFields, []string{"enabled"})
	covered(t, "Application.status", crdProps(t, appFile, app, "status"), applicationStatusFields, []string{"operationState"})
	covered(t, "Application.status.operationState", crdProps(t, appFile, app, "status", "operationState"), applicationOperationStateFields, []string{"phase"})
	covered(t, "Kustomization.spec", crdProps(t, "kustomize-controller.crds.yaml", "kustomizations.kustomize.toolkit.fluxcd.io", "spec"), kustomizationSpecFields, []string{"suspend"})
	covered(t, "HelmRelease.spec", crdProps(t, "helm-controller.crds.yaml", "helmreleases.helm.toolkit.fluxcd.io", "spec"), helmReleaseSpecFields, []string{"suspend"})
}
