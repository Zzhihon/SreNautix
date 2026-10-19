package admission

import (
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/execution"
)

// ProbeObject 返回准入自检的探针：一个带 ProbeLabel=<策略短名> 的合法 ActionExecution，以 dryRun=All 提交，
// 必须被该短名的策略拒绝。
func ProbeObject(namespace, short string) *execution.ActionExecution {
	id := strings.Repeat("0", 32)
	at := metav1.NewTime(time.Unix(0, 0).UTC())
	return &execution.ActionExecution{
		ObjectMeta: metav1.ObjectMeta{Name: id, Namespace: namespace, Labels: map[string]string{ProbeLabel: short}},
		Spec: execution.Spec{
			ExecutionID: id, TicketID: "probe", ProposalID: "00000000-0000-4000-8000-000000000000", Cluster: "probe",
			Action: "probe", Level: "irreversible", Tier: "H",
			Target:     execution.TargetRef{Version: "v1", Kind: "Probe", Resource: "probes", Name: "probe", UID: "probe"},
			Params:     runtime.RawExtension{Raw: []byte("{}")},
			ParamsHash: "sha256:" + strings.Repeat("0", 64), AssertionHash: "sha256:" + strings.Repeat("0", 64),
			CanonVersion: "jcs-sha256-v1", Envelope: "{}", Approver: execution.Approver{Principal: "probe", Channel: "probe"},
			Incident:       execution.Incident{ID: "probe", Version: 1, RootComponent: "probe", EvidenceFingerprint: "probe"},
			ConflictDomain: "probe", PulledAt: at, ApprovalExpiresAt: at, ProposalExpiresAt: at,
		},
	}
}
