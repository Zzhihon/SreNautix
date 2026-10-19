package admission

// 准入策略比较"除允许修改的字段外其余保持原值"时逐个列出的字段。CEL 不能从类型化对象中删除字段后整体比较，
// 所以按资源列出全部字段；fields_test.go 用仓库中固定版本的 CRD（test/crds/）核对列表覆盖了 CRD 的全部字段。
// 列表可以包含旧版本或新版本才有的字段：对不存在的字段，`object.x.?f == oldObject.x.?f` 两边都是空值。

var deploymentSpecFields = []string{
	"selector", "template", "strategy", "minReadySeconds", "revisionHistoryLimit", "progressDeadlineSeconds",
}

var statefulSetSpecFields = []string{
	"selector", "template", "serviceName", "podManagementPolicy", "updateStrategy", "revisionHistoryLimit",
	"minReadySeconds", "persistentVolumeClaimRetentionPolicy", "ordinals", "volumeClaimTemplates",
}

var hpaSpecFields = []string{"scaleTargetRef", "metrics", "behavior"}

var cronJobSpecFields = []string{
	"schedule", "timeZone", "startingDeadlineSeconds", "concurrencyPolicy", "jobTemplate",
	"successfulJobsHistoryLimit", "failedJobsHistoryLimit",
}

var nodeSpecFields = []string{"podCIDR", "podCIDRs", "providerID", "taints", "configSource", "externalID"}

// cnpgStatusFields 是 Cluster status 中除 promote 写入的字段（targetPrimary、targetPrimaryTimestamp、phase、
// phaseReason、conditions）之外的字段，取 cloudnative-pg 1.27 与 1.30 的并集。
var cnpgStatusFields = []string{
	"availableArchitectures", "certificates", "cloudNativePGCommitHash", "cloudNativePGOperatorHash",
	"configMapResourceVersion", "currentPrimary", "currentPrimaryFailingSinceTimestamp", "currentPrimaryTimestamp",
	"danglingPVC", "demotionToken", "firstRecoverabilityPoint", "firstRecoverabilityPointByMethod", "healthyPVC",
	"image", "initializingPVC", "instanceNames", "instances", "instancesReportedState", "instancesStatus", "jobCount",
	"lastFailedBackup", "lastPromotionToken", "lastSuccessfulBackup", "lastSuccessfulBackupByMethod",
	"latestGeneratedNode", "managedRolesStatus", "onlineUpdateEnabled", "pgDataImageInfo", "pluginStatus",
	"podSelectorRefs", "poolerIntegrations", "pvcCount", "readService", "readyInstances", "resizingPVC",
	"secretsResourceVersion", "selector", "switchReplicaClusterStatus", "systemID", "tablespacesStatus",
	"targetPgDataImageInfo", "timelineID", "topology", "unusablePVC", "writeService",
}

// cnpgPromoteFields 是 kubectl cnpg promote 写入的 status 字段。
var cnpgPromoteFields = []string{"targetPrimary", "targetPrimaryTimestamp", "phase", "phaseReason", "conditions"}

var applicationSpecFields = []string{
	"source", "sources", "destination", "project", "ignoreDifferences", "info", "revisionHistoryLimit", "sourceHydrator",
}

var applicationSyncPolicyFields = []string{"syncOptions", "retry", "managedNamespaceMetadata"}

var applicationAutomatedFields = []string{"prune", "selfHeal", "allowEmpty"}

// applicationStatusFields 是 status 中除 operationState 之外的字段。
var applicationStatusFields = []string{
	"conditions", "controllerNamespace", "health", "history", "observedAt", "reconciledAt", "resourceHealthSource",
	"resources", "sourceHydrator", "sourceType", "sourceTypes", "summary", "sync",
}

var applicationOperationStateFields = []string{"finishedAt", "message", "operation", "retryCount", "startedAt", "syncResult"}

// workflowSpecFields 是 Argo Workflows 3.7 WorkflowSpec 中除 workflowTemplateRef、arguments、shutdown 之外的字段。
var workflowSpecFields = []string{
	"activeDeadlineSeconds", "affinity", "archiveLogs", "artifactGC", "artifactRepositoryRef",
	"automountServiceAccountToken", "dnsConfig", "dnsPolicy", "entrypoint", "executor", "executorPlugins", "hooks",
	"hostAliases", "hostNetwork", "imagePullSecrets", "metrics", "nodeSelector", "onExit", "parallelism",
	"podDisruptionBudget", "podGC", "podMetadata", "podPriorityClassName", "podResources", "podSpecPatch", "priority",
	"resourceClaims", "retryStrategy", "schedulerName", "securityContext", "serviceAccountName", "suspend",
	"synchronization", "templateDefaults", "templates", "tolerations", "ttlStrategy", "volumeClaimGC",
	"volumeClaimTemplates", "volumes", "workflowMetadata",
}

var kustomizationSpecFields = []string{
	"commonMetadata", "components", "decryption", "deletionPolicy", "dependsOn", "force", "healthCheckExprs",
	"healthChecks", "ignoreMissingComponents", "images", "interval", "kubeConfig", "namePrefix", "nameSuffix",
	"patches", "path", "postBuild", "prune", "retryInterval", "serviceAccountName", "sourceRef", "targetNamespace",
	"timeout", "wait",
}

var helmReleaseSpecFields = []string{
	"chart", "chartRef", "commonMetadata", "dependsOn", "driftDetection", "install", "interval", "kubeConfig",
	"maxHistory", "persistentClient", "postRenderers", "releaseName", "rollback", "serviceAccountName",
	"storageNamespace", "targetNamespace", "test", "timeout", "uninstall", "upgrade", "values", "valuesFrom",
}
