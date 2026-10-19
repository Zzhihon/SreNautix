package invariants

import (
	"testing"

	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/admission"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/catalog"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/gwtest"
	"github.com/Zzhihon/SreNautix/internal/spoke/testenv"
)

// 不变量 4：gateway 的 ServiceAccount 对准入配置、RBAC、token、Secret 都没有权限。
// 启用目录中的全部动作，按生成的规则授权后，以 gateway 身份逐项 SelfSubjectAccessReview（等价于 kubectl auth can-i）。
func TestInvariant04NoPrivilegedPermissions(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	var all []string
	for _, a := range cat.Actions {
		all = append(all, a.ID)
	}
	e := gwtest.New(t, all)
	gw := gatewayCore(t, e)
	type probe struct {
		group, resource, subresource, verb, namespace, name string
	}
	verbs := []string{"get", "list", "watch", "create", "update", "patch", "delete", "deletecollection"}
	var probes []probe
	for _, ns := range []string{"", gwtest.AppNS, testenv.Namespace} {
		for _, v := range verbs {
			probes = append(probes,
				probe{"", "secrets", "", v, ns, ""},
				probe{"admissionregistration.k8s.io", "validatingadmissionpolicies", "", v, "", ""},
				probe{"admissionregistration.k8s.io", "validatingadmissionpolicybindings", "", v, "", ""},
				probe{"admissionregistration.k8s.io", "validatingwebhookconfigurations", "", v, "", ""},
				probe{"admissionregistration.k8s.io", "mutatingwebhookconfigurations", "", v, "", ""},
				probe{"rbac.authorization.k8s.io", "roles", "", v, ns, ""},
				probe{"rbac.authorization.k8s.io", "rolebindings", "", v, ns, ""},
				probe{"rbac.authorization.k8s.io", "clusterroles", "", v, "", ""},
				probe{"rbac.authorization.k8s.io", "clusterrolebindings", "", v, "", ""},
				probe{"", "serviceaccounts", "", v, ns, ""},
				probe{"certificates.k8s.io", "certificatesigningrequests", "", v, "", ""},
			)
		}
		probes = append(probes,
			probe{"", "serviceaccounts", "token", "create", ns, "srenautix-gateway"},
			probe{"rbac.authorization.k8s.io", "clusterroles", "", "escalate", "", ""},
			probe{"rbac.authorization.k8s.io", "clusterroles", "", "bind", "", ""},
			probe{"", "users", "", "impersonate", "", ""},
			probe{"", "serviceaccounts", "", "impersonate", ns, ""},
		)
	}
	for _, v := range []string{"create", "update", "patch", "delete"} {
		probes = append(probes, probe{"", "configmaps", "", v, testenv.Namespace, "srenautix-freeze"})
	}
	for _, p := range probes {
		r, err := gw.AuthorizationV1().SelfSubjectAccessReviews().Create(bg, &authorizationv1.SelfSubjectAccessReview{
			Spec: authorizationv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &authorizationv1.ResourceAttributes{
				Group: p.group, Resource: p.resource, Subresource: p.subresource, Verb: p.verb, Namespace: p.namespace, Name: p.name}},
		}, metav1.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if r.Status.Allowed {
			t.Errorf("gateway may %s %s/%s %s in %q", p.verb, p.group, p.resource, p.subresource, p.namespace)
		}
	}
	// 生成的规则本身不含这些资源与通配符
	out, err := admission.Generate(cat, admission.Options{Username: testenv.GatewayUser, Prefix: gwtest.Prefix})
	if err != nil {
		t.Fatal(err)
	}
	forbidden := map[string]bool{"secrets": true, "serviceaccounts": true, "serviceaccounts/token": true, "*": true}
	for id, entry := range out.Index.Actions {
		for _, r := range append(entry.Rules, admission.BaseRules()...) {
			for _, g := range r.APIGroups {
				if g == "*" || g == "rbac.authorization.k8s.io" || g == "admissionregistration.k8s.io" || g == "certificates.k8s.io" {
					t.Errorf("%s grants API group %s", id, g)
				}
			}
			for _, res := range r.Resources {
				if forbidden[res] {
					t.Errorf("%s grants %s", id, res)
				}
			}
			for _, v := range r.Verbs {
				if v == "*" || v == "escalate" || v == "bind" || v == "impersonate" {
					t.Errorf("%s grants verb %s", id, v)
				}
			}
		}
	}
}
