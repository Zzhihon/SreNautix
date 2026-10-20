// 本文件由 packages/contract/scripts/gen.ts 从 contract/ 生成，不要手工修改。
export type paths = {
  '/healthz': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getHealthz'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/readyz': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getReadyz'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/agent/cost': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getAgentCost'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/agent/health': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description P0 记分卡（DESIGN 附录 A）与运行指标 */
    get: operations['getAgentHealth'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/api-tokens': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listApiTokens'];
    put?: never;
    post: operations['createApiToken'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/api-tokens/{token_id}': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        token_id: string;
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete: operations['deleteApiToken'];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/approvals/batch': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description 批量审批只允许同类型、同集群、L 档的提议；每个提议独立处理，逐项返回结果 */
    post: operations['batchApprove'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/audit/chains': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listAuditChains'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/audit/records': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description 执行链的记录结构见 contract/gateway/v1/audit-record.schema.json；治理链的记录结构见 docs/server/audit.md */
    get: operations['listAuditRecords'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/auth/link-code': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description 生成一次性聊天账号绑定码，在聊天里发送 `/link <code>` 完成绑定（DESIGN §9.2） */
    post: operations['createLinkCode'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/auth/login': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description 本地管理员登录（只用于首次引导与紧急入口），必须带 TOTP。失败到一定次数会锁定。成功后设置会话 cookie */
    post: operations['loginLocal'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/auth/logout': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['logout'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/auth/oidc/callback': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['oidcCallback'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/auth/oidc/start': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['startOidc'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/auth/providers': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description 登录页显示的登录方式 */
    get: operations['listAuthProviders'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/auth/reauth': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description 本地管理员的重新认证（口令加 TOTP），更新会话的 auth_time；OIDC 用户改用 `oidc/start?max_age=0` */
    post: operations['reauthLocal'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/auth/session': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getSession'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/auth/webauthn/assertion-options': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description 合规配置下 H 档审批的通行密钥挑战；挑战绑定提议的 params_hash 与绑定字段，只能用一次 */
    post: operations['webauthnAssertionOptions'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/catalog/actions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description 生效的动作目录（结构以 contract/gateway/ 的动作目录 schema 为准），以及每个动作在各集群的启用状态 */
    get: operations['listCatalogActions'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/chat-links': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description 当前用户的聊天账号绑定 */
    get: operations['listChatLinks'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/chat-links/{channel}/{channel_user_id}': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        channel: components['schemas']['Channel'];
        channel_user_id: string;
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /** @description 解除绑定；本人或有 settings.write 权限的主体可以操作，写入治理审计 */
    delete: operations['deleteChatLink'];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/clusters': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listClusters'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/clusters/{cluster_id}': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        cluster_id: components['schemas']['ClusterId'];
      };
      cookie?: never;
    };
    get: operations['getCluster'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/conditions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description 全部角色发布的状态条件（DESIGN §12.4），驱动状态条 */
    get: operations['listConditions'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/egress/ledger': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getEgressLedger'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/eval/cases': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listEvalCases'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/eval/estimate': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description 运行前的成本估算，不调用模型 */
    post: operations['estimateEval'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/eval/reports': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listEvalReports'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/eval/reports/{report_id}': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        report_id: components['schemas']['Uuid'];
      };
      cookie?: never;
    };
    get: operations['getEvalReport'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/eval/trend': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getEvalTrend'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/events': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * @description 事件流（DESIGN §2.3）。按游标读取 server 与 worker 两张 outbox 合并后的事件。
     *     `Accept: application/json` 时长轮询：没有新事件时最多等待 wait 秒；`Accept: text/event-stream` 时为 SSE，
     *     每条事件的 SSE id 为它的游标，断线后用 Last-Event-ID 续传。投递语义是至少一次，消费者按 event_id 幂等处理
     */
    get: operations['listEvents'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/freeze': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description 硬停止（srenautix-freeze）的状态与操作说明；控制台只读，修改只能用 kubectl 或 GitOps */
    get: operations['getFreeze'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/incidents': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * @description 事件收件箱，按 first_firing_at 从新到旧。被抑制的事件不隐藏：suppressed=false（默认）时不返回明细，
     *     只在 suppressed_count 中计数。feedback=pending 表示最近一次完成的研判还没有反馈或反馈已过期。
     *     blind_spans 给出查询时段内接入静默或观测失明的时段，供收件箱画盲区色带。
     */
    get: operations['listIncidents'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/incidents/{incident_ref}': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
        incident_ref: components['parameters']['IncidentRef'];
      };
      cookie?: never;
    };
    get: operations['getIncident'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/incidents/{incident_ref}/evidence': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
        incident_ref: components['parameters']['IncidentRef'];
      };
      cookie?: never;
    };
    /** @description 研判当时保存的证据卡结果（模型所见的快照）；不填 run_id 时取最新阶段 A 报告的卡 */
    get: operations['getEvidenceSnapshot'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/incidents/{incident_ref}/evidence/rerun': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
        incident_ref: components['parameters']['IncidentRef'];
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * @description 控制台的"实时重跑"：只重跑这次研判时声明过的证据卡，在限定窗口内、按用户作用域执行；不提供通用数据源代理
     *     （DESIGN 附录 C）。结果并排显示，并标注"非模型所见"，不写入研判
     */
    post: operations['rerunEvidence'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/incidents/{incident_ref}/feedback': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
        incident_ref: components['parameters']['IncidentRef'];
      };
      cookie?: never;
    };
    get: operations['listFeedback'];
    put?: never;
    /**
     * @description 追加一条反馈。渠道和主体取自认证上下文：控制台会话为 console，Grafana 插件转发时为 grafana，
     *     聊天渠道桥转发时带签名的渠道回调。verdict 与 disposition_verdict 至少填一个；root_component 必须是本次研判拓扑中的组件。
     *     进行中的事件同样接受反馈
     */
    post: operations['createFeedback'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/incidents/{incident_ref}/research': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
        incident_ref: components['parameters']['IncidentRef'];
      };
      cookie?: never;
    };
    get: operations['listResearchRuns'];
    put?: never;
    /** @description 人工请求重新研判（reason=manual）。受每个事件每 6 小时最多 3 次的绝对上限约束，超过时返回 429 */
    post: operations['requestResearch'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/incidents/{incident_ref}/stage-a': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
        incident_ref: components['parameters']['IncidentRef'];
      };
      cookie?: never;
    };
    /** @description 最新的阶段 A 报告 */
    get: operations['getStageAReport'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/incidents/{incident_ref}/stage-a/recompute': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
        incident_ref: components['parameters']['IncidentRef'];
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * @description 按当前加载的领域包与当前拓扑重新计算事件当前版本的阶段 A（证据卡、规则提议与处置判断），替换该版本的报告并发布 stage_a.reported。
     *     只算阶段 A，不触发模型研判。写入治理审计。领域包变化（pack.lock 变化）后，仍在触发的事件由中心按限速自动重算（ADR 0107）
     */
    post: operations['recomputeStageA'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/incidents/{incident_ref}/subgraph': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
        incident_ref: components['parameters']['IncidentRef'];
      };
      cookie?: never;
    };
    /** @description 根因子图：根因加不超过 hops 跳的邻居，取该事件版本使用的拓扑版本；边带来源与置信度 */
    get: operations['getIncidentSubgraph'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/incidents/{incident_ref}/timeline': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
        incident_ref: components['parameters']['IncidentRef'];
      };
      cookie?: never;
    };
    /** @description 事件时间线（一条泳道）：告警触发与恢复、变更、异常卡、研判与提议的状态变化 */
    get: operations['getIncidentTimeline'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/ingest/{source_id}': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        source_id: string;
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * @description 告警接入（DESIGN §3.1）。每个接入源有自己的 bearer token；请求体按接入源的类型解析：Alertmanager 或 Grafana 的 webhook、
     *     夜莺事件、通用 JSON（按 JSONPath 映射）。状态库不可用时走降级路径，返回 202
     */
    post: operations['ingestAlerts'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/integrations': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listIntegrations'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/integrations/{instance_id}/test': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        instance_id: string;
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description 服务端连接测试：逐项执行声明能力的 verify() */
    post: operations['testIntegration'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/models/routes': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listModelRoutes'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/packs': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listPacks'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/pause': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description 软暂停：server 扣住工单，不下发 */
    get: operations['getPause'];
    put: operations['setPause'];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/permissions/explain': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description 逐条列出每个角色绑定是否匹配；解释其他主体时需要 users.read */
    post: operations['explainPermission'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/policies': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getPolicies'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/policies/simulate': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description 选定动作和目标，查看结果和需要谁审批；不产生提议 */
    post: operations['simulatePolicy'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/proposals': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listProposals'];
    put?: never;
    /**
     * @description 提议中转。source 由认证上下文决定：控制台会话为 human，API token 与 MCP 为 external，worker 的服务身份为 research。
     *     相同幂等键的未结束提议存在时返回 200 与已有提议；绑定字段与事件当前状态不一致时返回 409
     */
    post: operations['createProposal'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/proposals/{proposal_id}': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        proposal_id: components['parameters']['ProposalId'];
      };
      cookie?: never;
    };
    /** @description 提议全文，加上审批页按顺序展示的机器推导字段；预检由服务端在本次请求时重新执行 */
    get: operations['getProposal'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/proposals/{proposal_id}/approve': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        proposal_id: components['parameters']['ProposalId'];
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * @description 审批并签发审批断言（格式见 contract/gateway/v1/approval-envelope.schema.json）。
     *     L 档可经聊天渠道（已绑定账号）或控制台审批；H 档只能在控制台，并且 5 分钟内重新认证过，请求体必须带 confirm_target。
     *     审批人的作用域按目标 UID 所在的命名空间计算
     */
    post: operations['approveProposal'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/proposals/{proposal_id}/reject': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        proposal_id: components['parameters']['ProposalId'];
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['rejectProposal'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/proposals/{proposal_id}/undo': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        proposal_id: components['parameters']['ProposalId'];
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description 请求撤销已执行的 reversible 动作；由 gateway 在冲突域内串行执行 */
    post: operations['undoProposal'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/role-bindings': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description 来自 Git 的角色绑定；revision 是 git-sync 写入的提交 SHA，没有时为全部文件内容的 sha256 */
    get: operations['listRoleBindings'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/runs/{run_id}': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        run_id: components['parameters']['RunId'];
      };
      cookie?: never;
    };
    /** @description 研判运行明细。原始提示词只对 auditor 和 admin 可见，其余角色看到脱敏后的内容 */
    get: operations['getResearchRun'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/runs/{run_id}/eval-case': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        run_id: components['parameters']['RunId'];
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description 把这次研判所属的事件加入评测用例：固化查询邻域（DESIGN §14.2），进入"稍后标注"队列 */
    post: operations['promoteEvalCase'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/runs/{run_id}/manifest': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        run_id: components['parameters']['RunId'];
      };
      cookie?: never;
    };
    get: operations['getResearchManifest'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/runs/{run_id}/prompt/raw': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        run_id: components['parameters']['RunId'];
      };
      cookie?: never;
    };
    /** @description 脱敏前的原始提示词（worker 未保存原文时返回 404），每次读取都写入治理审计 */
    get: operations['getRawPrompts'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/runs/{run_id}/prompts': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        run_id: components['parameters']['RunId'];
      };
      cookie?: never;
    };
    /** @description 脱敏后的提示词，研判运行明细使用 */
    get: operations['getRedactedPrompts'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/search': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['search'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/settings': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getSettings'];
    put: operations['putSettings'];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/topology/coverage': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description 覆盖表（DESIGN §4.4），控制台拓扑页的默认视图 */
    get: operations['getTopologyCoverage'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/topology/diff': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getTopologyDiff'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/topology/neighborhood': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getTopologyNeighborhood'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/topology/overrides/pr': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * @description 为未映射的告警生成拓扑覆盖规则的 PR；只推送到 srenautix/* 分支，从不合并。
     *     给出 incident_id 且开启了事件 issue 时，先确保该事件有 issue，PR 描述写 `Refs #<issue>`，issue 里回链 PR
     */
    post: operations['createTopologyOverridePr'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/users': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listUsers'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
};
export type webhooks = Record<string, never>;
export type components = {
  schemas: {
    action: {
      /**
       * @description allowed 只允许出现在 reversible 与 reversible_recreatable 动作上（不变量 7）。
       * @enum {string}
       */
      auto_execution: 'allowed' | 'forbidden';
      blast_radius: {
        /** @description L 档允许的最大爆炸半径；超过时需要 H 档。 */
        l_tier_max: number;
        method: string;
        /** @enum {string} */
        unit: 'pods' | 'nodes' | 'objects' | 'repositories';
      };
      /**
       * @description 冲突域类型。键由执行器根据解析出的目标计算：workload:<ns>/<Kind>/<name>、node:<name>、pg:<ns>/<cluster>、argocd:<ns>/<app>、flux:<ns>/<Kind>/<name>、workflow:<ns>/<template>、gitops:<owner>/<repo>。
       * @enum {string}
       */
      conflict_domain: 'workload' | 'node' | 'pg' | 'argocd' | 'flux' | 'workflow' | 'gitops';
      /**
       * @description 只用于 reversible_recreatable：可重建条件在执行时不成立时的等级。
       * @constant
       */
      fallback_level?: 'irreversible';
      /** @description 等级降为 fallback_level 时可接受的最低档位。 */
      fallback_min_tier?: components['schemas']['tier'];
      id: string;
      level: components['schemas']['level'];
      /** @description 该动作在其目录等级下可接受的最低档位。 */
      min_tier: components['schemas']['tier'];
      /** @description 参数的 JSON Schema（可移植子集：type、properties、required、additionalProperties:false、enum、pattern、minLength、maxLength、minimum、maximum、items）。所有动作的参数另外可以带 verify（见 promqlCondition）。 */
      params: {
        [key: string]: unknown;
      };
      prechecks: {
        description: string;
        id: string;
        /** @enum {string} */
        kind: 'k8s' | 'pdb' | 'promql' | 'git';
      }[];
      /** @description 只用于 reversible_recreatable：执行时重新核对的可重建条件。 */
      recreatable_conditions?: {
        /** @constant */
        controller_managed: true;
        min_ready_replicas: number;
        /** @constant */
        pdb_headroom: true;
      };
      target: components['schemas']['target'];
      title: string;
      undo: {
        /** @description compensate 时提议的补偿动作 ID。 */
        compensation_action?: string;
        description: string;
        /**
         * @description restore：自动恢复原状态（reversible）；recreate：由控制器重建（reversible_recreatable）；compensate：补偿需要再次审批（compensable）；none：无法撤销（irreversible）。
         * @enum {string}
         */
        kind: 'restore' | 'recreate' | 'compensate' | 'none';
      };
      verify: {
        checks: {
          description: string;
          id: string;
          /** @enum {string} */
          kind: 'k8s' | 'git';
        }[];
        window_seconds: number;
      };
      /** @description 执行与撤销会产生的全部 Kubernetes 写入。RBAC 与准入策略由此生成；gitops_pr 只写 Git，此列表为空。 */
      writes: {
        group: string;
        resource: string;
        subresource?: string;
        /** @enum {string} */
        verb: 'create' | 'patch';
      }[];
    };
    /**
     * ActionCatalog
     * @description 动作目录（DESIGN §9.1）。目录只描述动作本身；哪些动作启用、作用于哪些命名空间、能否自动执行由 gateway 策略决定。
     */
    'action-catalog.schema': {
      actions: components['schemas']['action'][];
      /** @constant */
      version: 1;
      $defs: {
        /** @enum {string} */
        level: 'reversible' | 'reversible_recreatable' | 'compensable' | 'irreversible';
        /** @enum {string} */
        tier: 'L' | 'H';
        action: {
          /**
           * @description allowed 只允许出现在 reversible 与 reversible_recreatable 动作上（不变量 7）。
           * @enum {string}
           */
          auto_execution: 'allowed' | 'forbidden';
          blast_radius: {
            /** @description L 档允许的最大爆炸半径；超过时需要 H 档。 */
            l_tier_max: number;
            method: string;
            /** @enum {string} */
            unit: 'pods' | 'nodes' | 'objects' | 'repositories';
          };
          /**
           * @description 冲突域类型。键由执行器根据解析出的目标计算：workload:<ns>/<Kind>/<name>、node:<name>、pg:<ns>/<cluster>、argocd:<ns>/<app>、flux:<ns>/<Kind>/<name>、workflow:<ns>/<template>、gitops:<owner>/<repo>。
           * @enum {string}
           */
          conflict_domain: 'workload' | 'node' | 'pg' | 'argocd' | 'flux' | 'workflow' | 'gitops';
          /**
           * @description 只用于 reversible_recreatable：可重建条件在执行时不成立时的等级。
           * @constant
           */
          fallback_level?: 'irreversible';
          /** @description 等级降为 fallback_level 时可接受的最低档位。 */
          fallback_min_tier?: components['schemas']['tier'];
          id: string;
          level: components['schemas']['level'];
          /** @description 该动作在其目录等级下可接受的最低档位。 */
          min_tier: components['schemas']['tier'];
          /** @description 参数的 JSON Schema（可移植子集：type、properties、required、additionalProperties:false、enum、pattern、minLength、maxLength、minimum、maximum、items）。所有动作的参数另外可以带 verify（见 promqlCondition）。 */
          params: {
            [key: string]: unknown;
          };
          prechecks: {
            description: string;
            id: string;
            /** @enum {string} */
            kind: 'k8s' | 'pdb' | 'promql' | 'git';
          }[];
          /** @description 只用于 reversible_recreatable：执行时重新核对的可重建条件。 */
          recreatable_conditions?: {
            /** @constant */
            controller_managed: true;
            min_ready_replicas: number;
            /** @constant */
            pdb_headroom: true;
          };
          target: components['schemas']['target'];
          title: string;
          undo: {
            /** @description compensate 时提议的补偿动作 ID。 */
            compensation_action?: string;
            description: string;
            /**
             * @description restore：自动恢复原状态（reversible）；recreate：由控制器重建（reversible_recreatable）；compensate：补偿需要再次审批（compensable）；none：无法撤销（irreversible）。
             * @enum {string}
             */
            kind: 'restore' | 'recreate' | 'compensate' | 'none';
          };
          verify: {
            checks: {
              description: string;
              id: string;
              /** @enum {string} */
              kind: 'k8s' | 'git';
            }[];
            window_seconds: number;
          };
          /** @description 执行与撤销会产生的全部 Kubernetes 写入。RBAC 与准入策略由此生成；gitops_pr 只写 Git，此列表为空。 */
          writes: {
            group: string;
            resource: string;
            subresource?: string;
            /** @enum {string} */
            verb: 'create' | 'patch';
          }[];
        };
        target: {
          group: string;
          kind: string;
          /** @description 目标可以是多种类型时列出全部（例如 Deployment 与 StatefulSet）。 */
          kinds?: {
            group: string;
            kind: string;
            resource: string;
            version: string;
          }[];
          namespaced: boolean;
          resource: string;
          version: string;
        };
        /** @description 执行后校验条件：窗口结束时做一次即时查询，结果中的每个样本都必须满足 value <op> threshold。查询结果为空时按 on_empty 处理。 */
        promqlCondition: {
          id: string;
          /**
           * @default fail
           * @enum {string}
           */
          on_empty: 'fail' | 'pass';
          /** @enum {string} */
          op: 'lt' | 'le' | 'gt' | 'ge' | 'eq' | 'ne';
          query: string;
          threshold: number;
        };
      };
    };
    AgentHealth: {
      consecutive_days_met: number;
      required_days: number;
      runtime: {
        budget_cutoff_ratio: number | null;
        fallback_ratio: number | null;
        rerun_p95: number | null;
        untested_competitor_ratio: number | null;
        zero_tool_ratio: number | null;
      };
      scorecard: {
        /** @enum {string} */
        comparator: 'lt' | 'le' | 'ge' | 'eq';
        denominator: number | null;
        /** @description 只作为诊断指标公开，不计入达标 */
        diagnostic: boolean;
        met: boolean | null;
        /** @enum {string} */
        metric:
          | 'untested_competitor_ratio'
          | 'research_runs_p95'
          | 'feedback_per_week'
          | 'replay_top1'
          | 'benign_false_positive'
          | 'real_closed_loops'
          | 'out_of_catalog_writes'
          | 'portability_top1'
          | 'zero_tool_ratio';
        numerator: number | null;
        threshold: number;
        value: number | null;
      }[];
      since: components['schemas']['Timestamp'];
    };
    /**
     * AlertRole
     * @description 告警角色（DESIGN §3.2）：cause 原因；change 变更；symptom 症状；forecast 预测，不能成为活动事件的根因，也不能连接两个分组；meta 观测缺口
     * @enum {string}
     */
    AlertRole: 'cause' | 'change' | 'symptom' | 'forecast' | 'meta';
    /** IncidentAlias */
    Alias: {
      at_version: number;
      from_incident_id: components['schemas']['Uuid'];
      from_label: components['schemas']['IncidentLabel'];
      merged_at: components['schemas']['Timestamp'];
    };
    ApiToken: {
      created_at: components['schemas']['Timestamp'];
      created_by: string;
      expires_at: null | components['schemas']['Timestamp'];
      id: string;
      last_used_at: null | components['schemas']['Timestamp'];
      name: string;
      scopes: 'propose'[];
    };
    /**
     * ApprovalAssertion
     * @description 审批断言 v1（DESIGN §9.2）。字段集合固定为 15 个，全部必填。签名覆盖的是 approval-envelope 中定义的签名输入，签名输入包含本断言的 JCS（RFC 8785）规范化形式。
     */
    'approval-assertion.schema': {
      /** @description 动作目录中的动作 ID。 */
      action: string;
      /** @description 审批人主体。策略自动批准时为 "auto:<规则名>"。 */
      approver_principal: string;
      /**
       * @description 规范化版本：jcs-sha256-v1 表示 RFC 8785 JCS、UTF-8 编码、SHA-256、小写十六进制并带 "sha256:" 前缀。
       * @enum {string}
       */
      canon_version: 'jcs-sha256-v1';
      /** @description 审批渠道。策略自动批准时为 auto。 */
      channel: string;
      /** @description 被管集群的 cluster_id。 */
      cluster: components['schemas']['clusterId'];
      /** @description 提议绑定的证据指纹。 */
      evidence_fingerprint: components['schemas']['sha256'];
      /** @description 审批的过期时间，与提议的 TTL 相互独立。 */
      expires_at: components['schemas']['timestamp'];
      /** @description 提议绑定的事件版本。 */
      incident_version: number;
      /** @description 签发时间，UTC，RFC 3339，以 Z 结尾。 */
      issued_at: components['schemas']['timestamp'];
      /** @description 动作等级（DESIGN §9.1）：提议时按目录等级与目标状态确定。pod_restart 满足可重建条件时为 reversible_recreatable，否则为 irreversible。 */
      level: components['schemas']['level'];
      /** @description "sha256:" 加 sha256(JCS(params)) 的小写十六进制。 */
      params_hash: components['schemas']['sha256'];
      /** @description 提议 ID（UUID，小写）。 */
      proposal_id: string;
      /** @description 提议绑定的根因组件（组件键）。 */
      root_component: string;
      /** @description 目标对象的 metadata.uid；gitops_pr 为补丁所基于的 40 位提交 SHA。 */
      target_uid: string;
      /** @description 风险档位（DESIGN §9.2）。 */
      tier: components['schemas']['tier'];
      $defs: {
        /** @enum {string} */
        level: 'reversible' | 'reversible_recreatable' | 'compensable' | 'irreversible';
        /** @enum {string} */
        tier: 'L' | 'H';
        sha256: string;
        clusterId: string;
        timestamp: string;
      };
    };
    /**
     * ApprovalEnvelope
     * @description 审批断言及其签名证明。服务签名（service_ed25519）由 server 的服务签名密钥签发；通行密钥签名（webauthn）由审批人的 WebAuthn 凭据签发，算法（EdDSA 或 ES256）取自登记的凭据。签名输入与校验步骤见 docs/adr/0020-approval-assertion-format.md。
     */
    'approval-envelope.schema': {
      assertion: components['schemas']['approval-assertion.schema'];
      proof: components['schemas']['serviceProof'] | components['schemas']['webauthnProof'];
      $defs: {
        /** @description RFC 4648 §5 base64url，不带填充。 */
        base64url: string;
        /** @description 服务签名。签名输入为 ASCII "srenautix-approval-v1" 加一个换行符 0x0A，再接 JCS(statement) 的 UTF-8 字节；statement 为 {"assertion": assertion}，H 档时为 {"assertion": assertion, "reauth": reauth}。 */
        serviceProof: {
          /** @description 服务签名公钥的 ID，对应 approver-keys 中 use=service 的条目。 */
          key_id: string;
          reauth?: components['schemas']['reauth'];
          /** @description Ed25519 签名（64 字节）的 base64url。 */
          signature: components['schemas']['base64url'];
          /** @constant */
          type: 'service_ed25519';
        };
        /** @description H 档服务签名必须携带的重新认证凭据（OIDC max_age）。auth_time 不晚于 assertion.issued_at，且两者相差不超过 300 秒。 */
        reauth: {
          auth_time: string;
          /** @enum {string} */
          method: 'oidc_max_age' | 'local_totp';
          /** @description "sha256:" 加服务端会话 ID 的 SHA-256，用于在治理审计链中关联会话。 */
          session_hash: string;
        };
        /** @description 通行密钥签名（WebAuthn Level 3 断言）。clientDataJSON 的 type 为 webauthn.get，challenge 为 sha256(JCS(assertion)) 原始 32 字节的 base64url；签名覆盖 authenticatorData 与 sha256(clientDataJSON) 的拼接。签名算法由 approver-keys 中该凭据的 alg 决定：EdDSA 为 64 字节 Ed25519 签名，ES256 为 DER 编码的 ECDSA 签名。type 取 webauthn；webauthn_ed25519 只能用于 alg 为 EdDSA 的凭据，用于其他凭据时拒绝（webauthn_alg_mismatch）。 */
        webauthnProof: {
          authenticator_data: components['schemas']['base64url'];
          client_data_json: components['schemas']['base64url'];
          credential_id: components['schemas']['base64url'];
          /** @description EdDSA：64 字节（86 个字符）；ES256：DER 编码的 ECDSA-Sig-Value，至多 72 字节（96 个字符）。 */
          signature: components['schemas']['base64url'];
          /** @enum {string} */
          type: 'webauthn' | 'webauthn_ed25519';
        };
      };
    };
    ApprovalEnvelope: components['schemas']['approval-envelope.schema'];
    /** ApprovalIssuedEvent */
    ApprovalIssued: {
      payload: {
        assertion_id: components['schemas']['Uuid'];
        expires_at: components['schemas']['Timestamp'];
        proposal_id: components['schemas']['Uuid'];
        /** @enum {string} */
        tier: 'L' | 'H';
      };
      /** @constant */
      type: 'approval.issued';
    } & components['schemas']['Header'];
    /** ApprovalOutcome */
    ApprovalOutcome: {
      assertion_id: null | components['schemas']['Uuid'];
      message: string;
      /** @enum {string} */
      outcome:
        | 'approved'
        | 'rejected'
        | 'already_decided'
        | 'expired'
        | 'stale'
        | 'tier_requires_console'
        | 'not_linked'
        | 'forbidden'
        | 'replayed'
        | 'not_found';
      proposal_id: components['schemas']['Uuid'];
    };
    /** ApprovalRecord */
    ApprovalRecord: {
      /** @description 签发的审批断言 id；拒绝时为 null */
      assertion_id: null | components['schemas']['Uuid'];
      at: components['schemas']['Timestamp'];
      /**
       * @description Channel 的取值，或策略自动批准时的 auto
       * @enum {string}
       */
      channel: 'console' | 'grafana' | 'telegram' | 'feishu' | 'dingtalk' | 'wecom' | 'slack' | 'api' | 'mcp' | 'auto';
      /** @enum {string} */
      decision: 'approved' | 'rejected' | 'auto';
      principal_id: string;
      reason: string | null;
    };
    /** @description RFC 4648 §5 base64url，不带填充。 */
    base64url: string;
    /** ProposalBinding */
    Binding: {
      evidence_fingerprint: components['schemas']['Sha256'];
      incident_version: number;
      root_component: components['schemas']['ComponentKey'];
    };
    /** ChangeEvent */
    ChangeEvent: {
      actor: string | null;
      /** @description <source>:<来源内唯一标识>，用于去重 */
      change_id: string;
      /**
       * @description rollout：新 ReplicaSet/ControllerRevision；config：挂载的 ConfigMap 版本变化；cordon；scale：HPA 或手动扩缩；gitops_sync：Argo/Flux 同步；ci_deploy：CI 部署；operator：Operator 发起的切换或升级；other
       * @enum {string}
       */
      kind: 'rollout' | 'config' | 'cordon' | 'scale' | 'gitops_sync' | 'ci_deploy' | 'operator' | 'other';
      link: string | null;
      /** @description 来源中的引用，例如 Application 名、PR 号、流水线运行 id */
      refs: string[];
      revision: string | null;
      /** @description 集成实例 id，例如 argocd、flux、k8s-rollout、github */
      source: string;
      /** @description 不可信文本，只作为文本显示 */
      summary: string;
      /** @description 变更触及的拓扑节点 */
      targets: components['schemas']['ComponentKey'][];
      time: components['schemas']['Timestamp'];
    };
    /**
     * Channel
     * @description 提交渠道。console 为控制台，grafana 为 Grafana 嵌入，api 与 mcp 为外部调用方，其余为聊天渠道
     * @enum {string}
     */
    Channel: 'console' | 'grafana' | 'telegram' | 'feishu' | 'dingtalk' | 'wecom' | 'slack' | 'api' | 'mcp';
    ChatLink: {
      channel: components['schemas']['Channel'];
      channel_user_id: string;
      linked_at: components['schemas']['Timestamp'];
      /**
       * @description code 为 /link 绑定码；identity 为同一身份源自动绑定
       * @enum {string}
       */
      method: 'code' | 'identity';
    };
    Cluster: {
      cluster_id: components['schemas']['ClusterId'];
      conditions: components['schemas']['condition.schema'][];
      display_name: string;
      freeze: {
        frozen: boolean;
        observed_at: components['schemas']['Timestamp'];
      };
      gateway: null | components['schemas']['SpokeStatus'];
      informer_synced_at: null | components['schemas']['Timestamp'];
      /** @description 准入自检未通过、gateway 未部署或冻结时为 true；所有页面显示红色的"仅提议" */
      proposal_only: boolean;
      reader: components['schemas']['SpokeStatus'];
    };
    clusterId: string;
    /**
     * ClusterId
     * @description 集群标识，所有键都带它（DESIGN §2.2）
     */
    ClusterId: string;
    /**
     * ComponentKey
     * @description 拓扑节点的键：命名空间内的对象为 <kind>:<namespace>/<名称段>，集群级对象为 <kind>:<名称段>。kind 是 Kubernetes 的 Kind（如 Pod、Node，其他 API 组写作 Kind.group）或领域包声明的组件类型（如 postgres.cluster）；namespace 是 DNS 标签。名称段由对象名编码得到（ADR 0034）：名称的 UTF-8 字节中 A–Z a–z 0–9 '-' '.' '_' 原样保留，其余每个字节写成 '%' 加两位大写十六进制，例如 RBAC 对象 system:node 写作 ClusterRole:system%3Anode；DNS 名称编码后不变。解析时只接受这种规范编码。命名空间伪组件写作 Namespace:<namespace>。黄金向量见 contract/testvectors/component-keys.json
     */
    ComponentKey: string;
    /** @description 组件键 → 可读名称（领域包 ComponentType.display_name 求出，ADR 0101）。只用于显示；没有名称的组件不在其中，显示组件键 */
    ComponentNames: {
      [key: string]: string;
    };
    /** ResearchConclusion */
    Conclusion: {
      consistency: components['schemas']['ConsistencyChecks'];
      hypothesis_id: string | null;
      level: components['schemas']['ConclusionLevel'];
      root_component: null | components['schemas']['ComponentKey'];
      undetermined_reason: string | null;
    };
    /**
     * ConclusionLevel
     * @description 结论阶梯（DESIGN §7.3）。evidence_consistent 只能由代码判定
     * @enum {string}
     */
    ConclusionLevel: 'evidence_consistent' | 'likely' | 'inconclusive' | 'undetermined';
    /**
     * Condition
     * @description 带类型的状态条件（DESIGN §12.4），驱动每个页面顶部的状态条。每个判定都附带影响它的条件
     */
    'condition.schema': {
      cluster_id: null | components['schemas']['ClusterId'];
      message: string;
      reason: string;
      /** @enum {string} */
      role: 'server' | 'worker' | 'mcp' | 'reader' | 'gateway';
      since: components['schemas']['Timestamp'];
      /**
       * @description true 表示该问题正在发生
       * @enum {string}
       */
      status: 'true' | 'false';
      /** @description 条件涉及的对象，例如集成实例 id、路由 id、领域包名 */
      subject: string | null;
      /**
       * @description server、worker 等角色的条件；InformersFresh、TunnelConnected、QueryManifest、Datasource、AlertReconcile 由分支 reader 的心跳转来（role 为 reader，见 gateway/v1/reader.openapi.yaml 的 ReaderCondition），ClockSkew 两边都有。控制台必须容忍以后新增的类型
       * @enum {string}
       */
      type:
        | 'IngestSilent'
        | 'WatchdogMissing'
        | 'DatasourceUnavailable'
        | 'ModelRouteBreakerOpen'
        | 'AdmissionSelfTestFailed'
        | 'PackLoadFailed'
        | 'BudgetCutoffHigh'
        | 'ChannelDeliveryFailed'
        | 'AuditExportLagging'
        | 'ClockSkew'
        | 'StateStoreDegraded'
        | 'Restored'
        | 'Frozen'
        | 'StormMode'
        | 'InformersFresh'
        | 'TunnelConnected'
        | 'QueryManifest'
        | 'Datasource'
        | 'AlertReconcile';
    };
    /** ConditionChangedEvent */
    ConditionChanged: {
      payload: components['schemas']['condition.schema'];
      /** @constant */
      type: 'condition.changed';
    } & components['schemas']['Header'];
    /**
     * ConsistencyChecks
     * @description evidence_consistent 的四个条件逐项结果（DESIGN §7.3）；四项全为 true 才是 evidence_consistent
     */
    ConsistencyChecks: {
      competitor_tested: boolean;
      entity_in_scope: boolean;
      no_contrary_normal: boolean;
      onset_precedes_symptom: boolean;
    };
    /**
     * Disposition
     * @description 处置判断：act 处理；ignore 忽略；escalate 升级；undetermined 无法判定
     * @enum {string}
     */
    Disposition: 'act' | 'ignore' | 'escalate' | 'undetermined';
    Drift: {
      detail: string | null;
      in_sync: boolean;
      live_sha: string | null;
    };
    /**
     * Duration
     * @description Prometheus 风格的时长，例如 30s、5m、2h、7d
     */
    Duration: string;
    /**
     * TopologyEdge
     * @description from 依赖 to：to 的故障沿边反向传播到 from
     */
    Edge: {
      /** @description 默认值由来源决定（structural 1.0、runtime 0.9 并随过期衰减、config_ref 0.7、network_policy 0.6、naming 0.3）。低于归并阈值 τ=0.6 的边只参与候选排序 */
      confidence: number;
      /** @description 边的依据，例如 ownerReference、env DATABASE_HOST=pg-rw、Tempo 服务图 */
      evidence: string;
      from: components['schemas']['ComponentKey'];
      provenance: components['schemas']['Provenance'];
      /** @description 关系名，例如 owned_by、runs_on、mounts、bound_to、provisioned_by、selects、routes_to、calls、references、egress_to、operator_convention、named_like */
      relation: string;
      /**
       * @description instance：只把同一实例的故障联系起来（Pod→节点、Pod→PVC→PV→CSI）；service：沿服务依赖传播
       * @enum {string}
       */
      scope: 'instance' | 'service';
      to: components['schemas']['ComponentKey'];
    };
    /**
     * Egress
     * @description 卡片级出境控制（DESIGN §8.4）：allow 原样进入提示词；redact 脱敏后进入；never 不进入提示词
     * @enum {string}
     */
    Egress: 'allow' | 'redact' | 'never';
    /** EgressEntry */
    EgressEntry: {
      bytes: number;
      categories: ('metrics' | 'logs' | 'traces' | 'events' | 'topology' | 'changes' | 'alerts' | 'knowledge')[];
      in_domain: boolean;
      redaction_hits: number;
      route_id: string;
    };
    /**
     * EntityRef
     * @description 一个 Kubernetes 对象或领域包组件实例。uid 在实体解析成功时填写
     */
    EntityRef: {
      cluster_id: components['schemas']['ClusterId'];
      kind: string;
      name: string;
      namespace: string | null;
      uid: string | null;
    };
    /** Error */
    Error: {
      /** @description 机器可读的错误码 */
      error: string;
      message: string;
    };
    /**
     * EvalReport
     * @description 回放与评测的成绩单（DESIGN §14），按模型 × 用例集给出。对外公布时始终同时给出分子和分母；snapshot 与 reconstructed 两种模式的成绩分开报告
     */
    'eval-report.schema': {
      case_set: string;
      code_sha: string;
      created_at: components['schemas']['Timestamp'];
      /** @description 发布门禁结果；只评测、不做比较时为 null */
      gate: null | components['schemas']['Gate'];
      /** @enum {string} */
      mode: 'snapshot' | 'reconstructed';
      pack_lock: components['schemas']['Sha256'];
      report_id: components['schemas']['Uuid'];
      rows: components['schemas']['ModelRow'][];
      runs_per_case: number;
      $defs: {
        /** EvalRatio */
        Ratio: {
          ci_high: number | null;
          /** @description 聚类自助法 90% 置信区间下界 */
          ci_low: number | null;
          denominator: number;
          numerator: number;
          value: number | null;
        };
        /** EvalModelRow */
        ModelRow: {
          benign_false_positive: components['schemas']['Ratio'];
          by_granularity: {
            [key: string]: components['schemas']['Ratio'];
          };
          cost_per_case: {
            currency: string;
            mean: number;
            p90: number;
          };
          /** @description 没有弃权（结论不是 undetermined 或 inconclusive）的运行占比 */
          coverage: components['schemas']['Ratio'];
          disposition_accuracy: components['schemas']['Ratio'];
          model: string;
          /**
           * @description 领域包早于事件或晚于事件，分两组报告
           * @enum {string}
           */
          pack_timing: 'pack_before_incident' | 'pack_after_incident' | 'all';
          /** @description 每个用例第一次运行命中的占比 */
          pass_at_1: components['schemas']['Ratio'];
          /** @description k 次运行全部命中的用例占比（k 为 runs_per_case） */
          pass_pow_k: components['schemas']['Ratio'];
          /** @description 评测期间观察到的服务方指纹；与路由当前指纹不同的成绩作废 */
          provider_fingerprints: string[];
          /** @description 前 3 个候选覆盖根因集合的运行占比 */
          recall_at_3: components['schemas']['Ratio'];
          /** @description 可靠性表：结论阶梯每一档的精确率（DESIGN §14.4）；evidence_consistent 的精确率下界低于 0.85 时该档自动降级 */
          reliability: {
            demoted: boolean;
            level: components['schemas']['ConclusionLevel'];
            precision: components['schemas']['Ratio'];
          }[];
          route_id: string;
          /** @description 同一用例的多次运行给出相同根因与相同处置判断的用例占比 */
          run_agreement: components['schemas']['Ratio'];
          /** @description 不弃权的运行中 top-1 命中的占比 */
          selective_accuracy: components['schemas']['Ratio'];
          snapshot_miss_rate: number | null;
          structured_output_failure: components['schemas']['Ratio'];
          /** @description top-1 落在根因集合内的运行占比（分母为有根因的用例的全部运行） */
          top1: components['schemas']['Ratio'];
          undetermined_ratio: components['schemas']['Ratio'];
        };
        /** EvalGate */
        Gate: {
          baseline_report_id: components['schemas']['Uuid'];
          /** @description 两份报告共有的用例数 n */
          paired_cases: number;
          /** @description 新减旧的 top-1 差值（按用例配对） */
          paired_delta: number;
          /** @description 新减旧的单侧 90% 下界 */
          paired_delta_low: number;
          passed: boolean;
          /** @description 基线 pass^k 通过、候选不通过的用例；不在 waived_cases 中的任何一条都使门禁失败 */
          regressed_cases: string[];
          /** @description n<100 时 -0.10，n≥100 时 -0.05 */
          threshold: number;
          waived_cases: string[];
        };
      };
    };
    EvalCase: {
      case_id: string;
      created_at: components['schemas']['Timestamp'];
      excluded: {
        /** @enum {string} */
        kind: 'incident_report' | 'feedback' | 'same_root_conclusion' | 'pack_knowledge' | 'retrieved_case';
        reason: string;
        ref: string;
      }[];
      incident_id: null | components['schemas']['Uuid'];
      label: string;
      last_results: {
        passes: number;
        route_id: string;
        runs: number;
        top1_hit: boolean | null;
      }[];
      /** @enum {string} */
      pack_timing: 'pack_before_incident' | 'pack_after_incident';
      /** @enum {string} */
      snapshot_status: 'queued' | 'frozen';
      suite: string;
      truth: {
        disposition: null | components['schemas']['Disposition'];
        /** @enum {string|null} */
        granularity: 'pod' | 'workload' | 'component' | 'node' | null;
        root_components: components['schemas']['ComponentKey'][];
      };
      /** @enum {string} */
      type: 'incident' | 'feedback' | 'benign' | 'abstain' | 'scenario';
    };
    /**
     * OutboxEvent
     * @description 事件流中的一条事件（DESIGN §2.3）。每个所有者（server、worker）各有一张只追加的 outbox，与状态变更写在同一事务里。消费者按游标调用 GET /v1/events?after=，投递语义是至少一次，按 event_id 幂等处理。type 决定 payload 的结构
     */
    'events.schema': {
      $defs: {
        /**
         * OutboxEventType
         * @enum {string}
         */
        EventType:
          | 'incident.created'
          | 'incident.updated'
          | 'incident.resolved'
          | 'incident.merged'
          | 'incident.split'
          | 'stage_a.reported'
          | 'research.queued'
          | 'research.concluded'
          | 'research.failed'
          | 'proposal.created'
          | 'proposal.updated'
          | 'approval.issued'
          | 'execution.updated'
          | 'feedback.recorded'
          | 'condition.changed';
        /**
         * OutboxOwner
         * @enum {string}
         */
        Owner: 'server' | 'worker';
        /** OutboxEventHeader */
        Header: {
          cluster_id: components['schemas']['ClusterId'];
          event_id: components['schemas']['Uuid'];
          occurred_at: components['schemas']['Timestamp'];
          owner: components['schemas']['Owner'];
          schema_version: string;
          /** @description 所有者 outbox 内单调递增；游标形如 <owner>:<seq> */
          seq: number;
        };
        /** IncidentUpsertedEvent */
        IncidentUpserted: {
          payload: components['schemas']['incident.schema'];
          /** @enum {unknown} */
          type: 'incident.created' | 'incident.updated' | 'incident.resolved';
        } & components['schemas']['Header'];
        /** IncidentMergedEvent */
        IncidentMerged: {
          payload: {
            from_incident_id: components['schemas']['Uuid'];
            into_incident_id: components['schemas']['Uuid'];
            into_version: number;
          };
          /** @constant */
          type: 'incident.merged';
        } & components['schemas']['Header'];
        /** IncidentSplitEvent */
        IncidentSplit: {
          payload: {
            from_incident_id: components['schemas']['Uuid'];
            from_version: number;
            new_incident_ids: components['schemas']['Uuid'][];
          };
          /** @constant */
          type: 'incident.split';
        } & components['schemas']['Header'];
        /** StageAReportedEvent */
        StageAReported: {
          payload: {
            /** @description 状态库降级时在内存中生成 */
            degraded: boolean;
            disposition: components['schemas']['Disposition'];
            evidence_fingerprint: components['schemas']['Sha256'];
            incident_id: components['schemas']['Uuid'];
            incident_version: number;
            report_id: components['schemas']['Uuid'];
          };
          /** @constant */
          type: 'stage_a.reported';
        } & components['schemas']['Header'];
        /** ResearchQueuedEvent */
        ResearchQueued: {
          payload: {
            incident_id: components['schemas']['Uuid'];
            incident_version: number;
            reason: components['schemas']['ResearchReason'];
            run_id: components['schemas']['Uuid'];
          };
          /** @constant */
          type: 'research.queued';
        } & components['schemas']['Header'];
        /**
         * ResearchReason
         * @description 触发研判的原因；(incident_id, incident_version, reason) 是触发的唯一键
         * @enum {string}
         */
        ResearchReason:
          | 'new_incident'
          | 'fingerprint_changed'
          | 'root_changed'
          | 'severity_raised'
          | 'feedback'
          | 'manual'
          | 'model_recovered'
          | 'resumed';
        /** ResearchConcludedEvent */
        ResearchConcluded: {
          payload: {
            evidence_fingerprint: components['schemas']['Sha256'];
            incident_id: components['schemas']['Uuid'];
            incident_version: number;
            output: components['schemas']['research-output.schema'];
            run_id: components['schemas']['Uuid'];
          };
          /** @constant */
          type: 'research.concluded';
        } & components['schemas']['Header'];
        /** ResearchFailedEvent */
        ResearchFailed: {
          payload: {
            incident_id: components['schemas']['Uuid'];
            incident_version: number;
            /** @enum {string} */
            kind:
              | 'model_unavailable'
              | 'breaker_open'
              | 'budget_exhausted'
              | 'deadline'
              | 'invalid_output'
              | 'datasource'
              | 'internal';
            message: string;
            run_id: components['schemas']['Uuid'];
          };
          /** @constant */
          type: 'research.failed';
        } & components['schemas']['Header'];
        /** ProposalChangedEvent */
        ProposalChanged: {
          payload: components['schemas']['proposal.schema'];
          /** @enum {unknown} */
          type: 'proposal.created' | 'proposal.updated';
        } & components['schemas']['Header'];
        /** ApprovalIssuedEvent */
        ApprovalIssued: {
          payload: {
            assertion_id: components['schemas']['Uuid'];
            expires_at: components['schemas']['Timestamp'];
            proposal_id: components['schemas']['Uuid'];
            /** @enum {string} */
            tier: 'L' | 'H';
          };
          /** @constant */
          type: 'approval.issued';
        } & components['schemas']['Header'];
        /** ExecutionUpdatedEvent */
        ExecutionUpdated: {
          payload: {
            execution: components['schemas']['ExecutionSummary'];
            proposal_id: components['schemas']['Uuid'];
          };
          /** @constant */
          type: 'execution.updated';
        } & components['schemas']['Header'];
        /** FeedbackRecordedEvent */
        FeedbackRecorded: {
          payload: components['schemas']['feedback.schema'];
          /** @constant */
          type: 'feedback.recorded';
        } & components['schemas']['Header'];
        /** ConditionChangedEvent */
        ConditionChanged: {
          payload: components['schemas']['condition.schema'];
          /** @constant */
          type: 'condition.changed';
        } & components['schemas']['Header'];
      };
    } & (
      | components['schemas']['IncidentUpserted']
      | components['schemas']['IncidentMerged']
      | components['schemas']['IncidentSplit']
      | components['schemas']['StageAReported']
      | components['schemas']['ResearchQueued']
      | components['schemas']['ResearchConcluded']
      | components['schemas']['ResearchFailed']
      | components['schemas']['ProposalChanged']
      | components['schemas']['ApprovalIssued']
      | components['schemas']['ExecutionUpdated']
      | components['schemas']['FeedbackRecorded']
      | components['schemas']['ConditionChanged']
    );
    /**
     * OutboxEventType
     * @enum {string}
     */
    EventType:
      | 'incident.created'
      | 'incident.updated'
      | 'incident.resolved'
      | 'incident.merged'
      | 'incident.split'
      | 'stage_a.reported'
      | 'research.queued'
      | 'research.concluded'
      | 'research.failed'
      | 'proposal.created'
      | 'proposal.updated'
      | 'approval.issued'
      | 'execution.updated'
      | 'feedback.recorded'
      | 'condition.changed';
    /**
     * EvidenceResult
     * @description 一张证据卡在一次研判（或阶段 A 报告）中的结果（DESIGN §6.1）。三种结论之外另有显示状态 capability_missing：所需的数据源能力不可用，和没有数据区分开
     */
    'evidence-result.schema': {
      /** @description 异常的起始时间，用于 evidence_consistent 判定中的时间条件；无法确定时为 null */
      anomaly_started_at?: null | components['schemas']['Timestamp'];
      /** @description <pack>/<chain>/<card>；区分性检查产生的卡为 check/<hypothesis id>/<n> */
      card_id: string;
      /**
       * @description verdict 为 undeterminable 且原因是所需能力不可用时为 capability_missing，其余与 verdict 相同
       * @enum {string}
       */
      display_state: 'normal' | 'abnormal' | 'undeterminable' | 'capability_missing';
      egress: components['schemas']['Egress'];
      entity: null | components['schemas']['EntityRef'];
      evaluated_at: components['schemas']['Timestamp'];
      queries: components['schemas']['QueryRecord'][];
      reason: components['schemas']['Reason'];
      ref: components['schemas']['EvidenceRef'];
      /** @description 每个查询引用的降采样序列（每条不超过 300 点），用于迷你图与实时重跑的并排对比。points 中每项为 [unix 秒, 值或 null] */
      series: {
        labels: components['schemas']['Labels'];
        points: [number, number | null][];
        /** @description 卡片中的引用名 */
        ref: string;
      }[];
      table: null | {
        head: string[];
        rows: string[][];
      };
      /** @description 展示用阈值线 */
      threshold: number | null;
      /** @description 取自卡片定义，结果脱离定义也能展示 */
      title: components['schemas']['LocalizedText'];
      /** @description 主值的展示文本 */
      value: string | null;
      verdict: components['schemas']['Verdict'];
      window: components['schemas']['TimeWindow'];
      $defs: {
        /** EvidenceReason */
        Reason: {
          /**
           * @description rule：命中判定规则；no_data：查询没有样本；partial_data：部分查询没有样本；source_error：数据源报错或超时；capability_missing：所需能力不可用；observability_gap：依赖的目标有 meta 告警；evaluation_error：CEL 求值出错；all_clear：没有命中任何规则；model_judged：只读工具的结果没有 CEL 判定，由小模型对照 refutes_if 判定（可以支持 likely，不能单独支撑 evidence_consistent，展示时标注模型判定）
           * @enum {string}
           */
          kind:
            | 'rule'
            | 'no_data'
            | 'partial_data'
            | 'source_error'
            | 'capability_missing'
            | 'observability_gap'
            | 'evaluation_error'
            | 'all_clear'
            | 'model_judged';
          text: string;
        };
        /** EvidenceQueryRecord */
        QueryRecord: {
          capability: string;
          duration_ms: number;
          error: string | null;
          /** @description 集成实例 id */
          integration: string;
          name: string;
          /** @description 实际执行的查询文本 */
          query: string;
          sample_count: number;
          truncated: boolean;
        };
      };
    };
    /**
     * EvidenceRef
     * @description 研判运行内的证据引用：card:<n> 指本次运行的第 n 张证据卡结果（含区分性检查产生的卡），alert:<n> 指事件成员告警，change:<n> 指关联的变更。编号由研判清单映射到定义和实体
     */
    EvidenceRef: string;
    /** ExecutionSummary */
    ExecutionSummary: {
      execution_id: string;
      phase: string;
      queue_position: number | null;
      updated_at: components['schemas']['Timestamp'];
    };
    /** ExecutionUpdatedEvent */
    ExecutionUpdated: {
      payload: {
        execution: components['schemas']['ExecutionSummary'];
        proposal_id: components['schemas']['Uuid'];
      };
      /** @constant */
      type: 'execution.updated';
    } & components['schemas']['Header'];
    /**
     * Feedback
     * @description 一条反馈（DESIGN §11），表只追加，同一事件以 created_at 最新的一条为准。两个维度：verdict 评价根因结论，disposition_verdict 评价处置判断。verdict=rejected 且 root_component=null 表示只否定结论、真实根因未知：不生成回放用例也不作为参考案例，计入准确率与校准统计，记为一次未命中。只有 linked=true（已绑定账号）的反馈进入评测的标准答案
     */
    'feedback.schema': {
      channel: components['schemas']['Channel'];
      created_at: components['schemas']['Timestamp'];
      /** @description disposition_verdict=rejected 时人工给出的正确处置判断 */
      disposition: null | components['schemas']['Disposition'];
      /**
       * @description 处置判断是否正确；只评价根因时为 null
       * @enum {string|null}
       */
      disposition_verdict: 'confirmed' | 'rejected' | null;
      feedback_id: components['schemas']['Uuid'];
      /**
       * @description 隐式反馈的来源：批准、拒绝、撤销自动记为对应反馈；resolved_confirm 是事件恢复时的一键确认。显式反馈为 null
       * @enum {string|null}
       */
      implicit: 'approved' | 'rejected' | 'undone' | 'resolved_confirm' | null;
      incident_id: components['schemas']['Uuid'];
      incident_version: number;
      /** @description 提交者是已绑定的账号（控制台登录或聊天账号经 /link 绑定） */
      linked: boolean;
      mechanism: string | null;
      principal_id: string;
      reason: string | null;
      /** @description 反馈针对的研判；针对阶段 A 报告时为 null */
      research_run_id: null | components['schemas']['Uuid'];
      /** @description verdict=rejected 时人工给出的真实根因组件，从本次研判的拓扑组件中选择；不知道时为 null */
      root_component: null | components['schemas']['ComponentKey'];
      /** @description 反馈之后又有研判完成（读取时计算） */
      stale: boolean;
      /**
       * @description 根因结论是否正确；只评价处置判断时为 null
       * @enum {string|null}
       */
      verdict: 'confirmed' | 'rejected' | null;
      $defs: {
        /**
         * FeedbackCreate
         * @description 提交反馈的请求体。channel 与主体由认证上下文决定，请求体不含
         */
        FeedbackCreate: {
          disposition: null | components['schemas']['Disposition'];
          /** @enum {string|null} */
          disposition_verdict: 'confirmed' | 'rejected' | null;
          mechanism: string | null;
          reason: string | null;
          research_run_id: null | components['schemas']['Uuid'];
          root_component: null | components['schemas']['ComponentKey'];
          /** @enum {string|null} */
          verdict: 'confirmed' | 'rejected' | null;
        };
      };
    };
    /**
     * FeedbackCreate
     * @description 提交反馈的请求体。channel 与主体由认证上下文决定，请求体不含
     */
    FeedbackCreate: {
      disposition: null | components['schemas']['Disposition'];
      /** @enum {string|null} */
      disposition_verdict: 'confirmed' | 'rejected' | null;
      mechanism: string | null;
      reason: string | null;
      research_run_id: null | components['schemas']['Uuid'];
      root_component: null | components['schemas']['ComponentKey'];
      /** @enum {string|null} */
      verdict: 'confirmed' | 'rejected' | null;
    };
    /** FeedbackRecordedEvent */
    FeedbackRecorded: {
      payload: components['schemas']['feedback.schema'];
      /** @constant */
      type: 'feedback.recorded';
    } & components['schemas']['Header'];
    /** EvalGate */
    Gate: {
      baseline_report_id: components['schemas']['Uuid'];
      /** @description 两份报告共有的用例数 n */
      paired_cases: number;
      /** @description 新减旧的 top-1 差值（按用例配对） */
      paired_delta: number;
      /** @description 新减旧的单侧 90% 下界 */
      paired_delta_low: number;
      passed: boolean;
      /** @description 基线 pass^k 通过、候选不通过的用例；不在 waived_cases 中的任何一条都使门禁失败 */
      regressed_cases: string[];
      /** @description n<100 时 -0.10，n≥100 时 -0.05 */
      threshold: number;
      waived_cases: string[];
    };
    /**
     * GatewayPolicy
     * @description gateway 策略，来自 Git，经 ConfigMap 挂载（DESIGN §2.1）。只能启用目录中的动作；准入策略与 RBAC 按同一份策略生成。
     */
    'gateway-policy.schema': {
      /** @description 启用的动作。未列出的动作不生成 RBAC 与准入策略，工单直接被拒绝。 */
      actions: {
        /** @description 自动执行只允许用于目录中 auto_execution=allowed 的动作，否则策略加载失败（不变量 7）。 */
        auto_execution?: {
          /** @description 自动执行的命名空间，必须是 namespaces 的子集；命名空间级动作必填，集群级动作不填。 */
          namespaces?: string[];
          /** @description 允许自动批准的规则名；断言 approver_principal 为 auto:<规则名>。 */
          rules: string[];
        };
        id: string;
        /** @description 允许的目标命名空间；命名空间级动作必填，集群级动作（节点）不填。 */
        namespaces?: string[];
      }[];
      /** @description 审批人的作用域（DESIGN §13 approver 角色）。gateway 按目标所在的命名空间核对。 */
      approvers: {
        /** @enum {string} */
        max_tier: 'L' | 'H';
        /** @description "*" 表示全部命名空间（含集群级目标）。 */
        namespaces: string[];
        principal: string;
      }[];
      /** @description 本集群的 cluster_id，必须与断言的 cluster 相同。 */
      cluster: string;
      /** @description gitops_pr 的仓库、路径白名单与补偿控制（ADR 0025）。 */
      gitops?: {
        /** @description 定期检查 base 分支上的提交：由机器人身份直接写入、或由机器人合并的提交为非人工提交，回看窗口内存在时条件 GitMainWatchdog 为 False，gitops_pr 停止推送。 */
        main_watchdog?: {
          /** @description 允许直接写入 base 的机器人账号（例如 renovate[bot]）；gateway 自己的 App 不能列在这里。 */
          allowed_bots?: string[];
          /** @description 检查间隔，Go duration，1s 到 1h，默认 5m。 */
          interval?: string;
          /** @description 回看窗口，Go duration，1h 到 168h，默认 24h。 */
          lookback?: string;
        };
        /** @description 每个仓库每小时最多开出的 PR 数（按进入 executing 的时间计），超出的工单以 gitops_rate_limited 拒绝。默认 2。 */
        max_prs_per_hour?: number;
        repositories: {
          base: string;
          /** @description base 分支没有分支保护时，经批准以补偿控制代替（不变量 12，ADR 0025）：只推送 srenautix/ 分支并在推送前后核对 base、从不合并、每次推送与开 PR 写入审计链、按小时限速、main watchdog。这一项记录批准人与依据，没有它时 base 必须有分支保护。 */
          compensating_controls?: {
            /** Format: date */
            approved_at: string;
            approved_by: string;
            /** @description 批准的出处（issue、章程、ADR 链接）。 */
            reference: string;
          };
          /** @description 允许修改的路径：以 / 结尾的目录前缀、完整路径，或含 * ? [ 的模式（path.Match 语义，* 不跨越 /）。 */
          paths: string[];
          repository: string;
          /** @description 开出 PR 后请求审阅的 GitHub 账号；工单参数中的 reviewers 必须是它的子集。 */
          reviewers?: string[];
        }[];
      };
      /** @default 6 */
      max_auto_executions_per_hour: number;
      /** @description SreNautix 自己的依赖集合（DESIGN §9.1 自我保护）。目标落在其中时一律按 irreversible 加 H 档处理，并且不自动执行。gateway 所在节点自动计入。 */
      self_dependencies?: {
        namespaces?: string[];
        nodes?: string[];
        pg_clusters?: {
          name: string;
          namespace: string;
        }[];
      };
      /** @constant */
      version: 1;
      /** @description workflow_submit 的模板白名单：名称、sha256(JCS(WorkflowTemplate.spec)) 与 ServiceAccount 都必须一致。 */
      workflow_templates?: {
        name: string;
        namespace: string;
        /** @description 参数名到约束；提交的参数必须恰好是这些名称。 */
        parameters: {
          [key: string]: {
            enum?: string[];
            max_length?: number;
            pattern?: string;
          };
        };
        service_account: string;
        sha256: string;
      }[];
    };
    /** OutboxEventHeader */
    Header: {
      cluster_id: components['schemas']['ClusterId'];
      event_id: components['schemas']['Uuid'];
      occurred_at: components['schemas']['Timestamp'];
      owner: components['schemas']['Owner'];
      schema_version: string;
      /** @description 所有者 outbox 内单调递增；游标形如 <owner>:<seq> */
      seq: number;
    };
    /** Hypothesis */
    Hypothesis: {
      id: string;
      mechanism: string;
      parent_id: string | null;
      refuting: components['schemas']['EvidenceRef'][];
      root_component: components['schemas']['ComponentKey'];
      /**
       * @description 假设账本状态：pending 待检验；supported 支持；refuted 推翻；inconclusive 检验后仍无法判定
       * @enum {string}
       */
      status: 'pending' | 'supported' | 'refuted' | 'inconclusive';
      supporting: components['schemas']['EvidenceRef'][];
    };
    /**
     * Incident
     * @description 持久化的事件（DESIGN §2.2、§5）。每次对账按确定性规则重算一次，再与已持久化的事件对账；成员或根因变化时 incident_version 加一
     */
    'incident.schema': {
      /** @description 合并进本事件的旧事件（incident_aliases：from → into）。旧 URL 与旧标签经别名解析到本事件 */
      aliases: components['schemas']['Alias'][];
      /** @description 前 k 个候选根因，按得分从高到低 */
      candidates: components['schemas']['RootCandidate'][];
      /** @description 首次触发前 30 分钟到结束之间、触及事件组件的变更 */
      changes: components['schemas']['ChangeEvent'][];
      cluster_id: components['schemas']['ClusterId'];
      /** @description 根因、候选与成员组件的可读名称；读取时由中心附上，事件流与旧版本的事件没有这个字段 */
      component_names?: components['schemas']['ComponentNames'];
      /** @description 成员告警涉及的组件，根因在前 */
      components: components['schemas']['ComponentKey'][];
      created_at: components['schemas']['Timestamp'];
      ended_at: null | components['schemas']['Timestamp'];
      first_firing_at: components['schemas']['Timestamp'];
      incident_id: components['schemas']['Uuid'];
      incident_version: number;
      label: components['schemas']['IncidentLabel'];
      members: components['schemas']['Member'][];
      /** @description state=merged 时指向吸收本事件的事件 */
      merged_into: null | components['schemas']['Uuid'];
      /** @description 至少 50% 的证据卡没有数据（DESIGN §7.1） */
      observability_blind: boolean;
      root: components['schemas']['Root'];
      severity: components['schemas']['Severity'];
      /** @description 本事件由哪个事件拆分而来 */
      split_from: null | components['schemas']['Uuid'];
      /** @enum {string} */
      state: 'firing' | 'resolved' | 'merged';
      /** @description 命中 SreNautix 自己的抑制规则，或全部触发中的成员都被告警源静默。只影响 SreNautix 的消息与研判 */
      suppressed: boolean;
      /** @description 本版本使用的拓扑事件 seq */
      topology_version: number;
      updated_at: components['schemas']['Timestamp'];
      $defs: {
        /**
         * IncidentLabel
         * @description 稳定标签 <根组件>:<首次触发时间取整到 10 分钟>，同一标签冲突时追加 ~2、~3
         */
        IncidentLabel: string;
        /** IncidentRoot */
        Root: {
          /** @description 第一与第二候选的分差小于 δ（默认 0.1）；两个候选的证据链都执行 */
          ambiguous: boolean;
          /** @description 排名第一的候选；没有候选时为 null */
          component: null | components['schemas']['ComponentKey'];
          entity: null | components['schemas']['EntityRef'];
          /** @description 第一与第二候选的分差；只有一个候选时为 null */
          margin: number | null;
          /** @description 根因由沉默根因探测卡加入，没有指向它的告警 */
          silent_root: boolean;
        };
        /** RootCandidate */
        RootCandidate: {
          component: components['schemas']['ComponentKey'];
          /** @description 在折叠强连通分量后的依赖图上的深度，只用于平分时排序 */
          depth: number;
          /** @description 能解释的症状告警 alert_id */
          explains: string[];
          score: number;
          /**
           * @description alert：有指向它的 cause/change 告警；change：有触及它的变更；hub：没有告警的集群枢纽，至少 3 个独立依赖方同时出现告警；probe：沉默根因探测卡异常；symptom：只有症状告警
           * @enum {string}
           */
          source: 'alert' | 'change' | 'hub' | 'probe' | 'symptom';
          terms: components['schemas']['ScoreTerms'];
        };
        /**
         * RootScoreTerms
         * @description 根因得分的各项（DESIGN §5），每项在 [0,1] 内，乘以 rca-params 中的权重后求和
         */
        ScoreTerms: {
          chronic_penalty: number;
          coverage: number;
          precedence: number;
          recent_change: number;
          role_prior: number;
        };
        /** IncidentMember */
        Member: {
          alert_id: string;
          alertname: string;
          component: null | components['schemas']['ComponentKey'];
          ends_at: null | components['schemas']['Timestamp'];
          joined_version: number;
          /** @description 拆分时离开本事件的版本；仍是成员时为 null */
          left_version: number | null;
          role: components['schemas']['AlertRole'];
          severity: components['schemas']['Severity'];
          starts_at: components['schemas']['Timestamp'];
          /** @enum {string} */
          status: 'firing' | 'resolved';
        };
        /** IncidentAlias */
        Alias: {
          at_version: number;
          from_incident_id: components['schemas']['Uuid'];
          from_label: components['schemas']['IncidentLabel'];
          merged_at: components['schemas']['Timestamp'];
        };
      };
    };
    /**
     * IncidentLabel
     * @description 稳定标签 <根组件>:<首次触发时间取整到 10 分钟>，同一标签冲突时追加 ~2、~3
     */
    IncidentLabel: string;
    /** IncidentMergedEvent */
    IncidentMerged: {
      payload: {
        from_incident_id: components['schemas']['Uuid'];
        into_incident_id: components['schemas']['Uuid'];
        into_version: number;
      };
      /** @constant */
      type: 'incident.merged';
    } & components['schemas']['Header'];
    /** IncidentSplitEvent */
    IncidentSplit: {
      payload: {
        from_incident_id: components['schemas']['Uuid'];
        from_version: number;
        new_incident_ids: components['schemas']['Uuid'][];
      };
      /** @constant */
      type: 'incident.split';
    } & components['schemas']['Header'];
    IncidentSummary: {
      ambiguous: boolean;
      cluster_id: components['schemas']['ClusterId'];
      /** @description 根因组件的可读名称（ADR 0101）；没有名称时为空对象 */
      component_names: components['schemas']['ComponentNames'];
      conclusion_level: null | components['schemas']['ConclusionLevel'];
      /** @description 最近一次研判的处置判断；只有阶段 A 时取阶段 A 的 */
      disposition: null | components['schemas']['Disposition'];
      ended_at: null | components['schemas']['Timestamp'];
      /** @description 最新一条反馈；没有时为 null */
      feedback: null | components['schemas']['feedback.schema'];
      first_firing_at: components['schemas']['Timestamp'];
      incident_id: components['schemas']['Uuid'];
      incident_version: number;
      label: components['schemas']['IncidentLabel'];
      merged_from_count: number;
      observability_blind: boolean;
      pending_approvals: number;
      /** @description 最近一次研判或阶段 A 报告的时间 */
      research_fresh_at: null | components['schemas']['Timestamp'];
      root_component: null | components['schemas']['ComponentKey'];
      severity: components['schemas']['Severity'];
      split_from: null | components['schemas']['Uuid'];
      /** @enum {string} */
      state: 'firing' | 'resolved' | 'merged';
      suppressed: boolean;
      updated_at: components['schemas']['Timestamp'];
    };
    /** IncidentUpsertedEvent */
    IncidentUpserted: {
      payload: components['schemas']['incident.schema'];
      /** @enum {unknown} */
      type: 'incident.created' | 'incident.updated' | 'incident.resolved';
    } & components['schemas']['Header'];
    IngestResult: {
      accepted: number;
      degraded: boolean;
      /** @description 被丢弃的告警数（Watchdog、severity=none、SreNautix 自身告警等） */
      dropped: number;
    };
    /**
     * IntegrationManifest
     * @description 集成清单 integration.yaml（DESIGN §10.1）。一项能力只有在清单里声明过、并且 verify() 通过，才算可用。控制台的集成页由清单生成
     */
    'integration-manifest.schema': {
      /** @constant */
      api_version: 'srenautix.io/integration/v1';
      capabilities: {
        name: string;
        /** @enum {string} */
        stability: 'alpha' | 'beta' | 'stable';
      }[];
      /** @enum {string} */
      category:
        'alerts' | 'metrics' | 'logs' | 'traces' | 'changes' | 'notify' | 'approve' | 'identity' | 'model' | 'execute';
      /** @description 实例配置的 JSON Schema。密钥字段只写挂载文件的引用，用 x-srenautix-secret-ref: true 标出 */
      config_schema: {
        [key: string]: unknown;
      };
      /** @description 实现的契约，例如 metrics/v1 */
      contract: string;
      /** @description 真实部署报告的链接 */
      deployment_reports?: string[];
      /**
       * @description 按方向分级（DESIGN §10.2）：approve、authenticate 只能是核心或官方；execute 只能是核心
       * @enum {string}
       */
      direction: 'read' | 'notify' | 'approve' | 'authenticate' | 'execute';
      display_name?: string;
      id: string;
      owner: string;
      /** @description 凭证需要的最小权限；启动时探测凭证是否超出，超出时降级为 warn 或只提议 */
      required_scopes: string[];
      /** @description 测过的后端版本矩阵 */
      tested_versions: {
        backend: string;
        /**
         * @description 徽章上注明的验证方式
         * @enum {string}
         */
        verification: 'kind_e2e' | 'testcontainers' | 'recorded_fixtures' | 'live_smoke';
        versions: string[];
      }[];
      /**
       * @description official_candidate：没有真实部署报告的官方级集成，不称为支持
       * @enum {string}
       */
      tier: 'core' | 'official' | 'official_candidate' | 'community' | 'mcp_bridge';
    };
    IntegrationInstance: {
      capabilities: {
        error: string | null;
        /** @enum {string} */
        maturity: 'alpha' | 'beta' | 'stable';
        name: string;
        verified: boolean;
        verified_at: null | components['schemas']['Timestamp'];
      }[];
      error_ratio_1h: number | null;
      git_source: {
        path: string;
        repo: string;
        sha: string;
      };
      instance_id: string;
      last_success_at: null | components['schemas']['Timestamp'];
      manifest: components['schemas']['integration-manifest.schema'];
      /** @description 凭证超出 requiredScopes，集成降级为 warn 或只提议 */
      over_privileged: boolean;
      /** @description 只有挂载文件的引用，永远不含密钥内容 */
      secret_refs: string[];
      used_by: {
        actions: string[];
        chains: string[];
      };
    };
    /** Labels */
    Labels: {
      [key: string]: string;
    };
    /** @enum {string} */
    level: 'reversible' | 'reversible_recreatable' | 'compensable' | 'irreversible';
    LlmCall: {
      at: components['schemas']['Timestamp'];
      cost: number;
      duration_ms: number;
      model: string;
      /** @enum {string} */
      outcome: 'succeeded' | 'retried' | 'switched' | 'failed';
      /** @enum {string} */
      phase: 'hypothesize' | 'conclude' | 'compress' | 'still_consistent' | 'repair';
      prompt_hash: components['schemas']['Sha256'];
      redaction_hits: number;
      /**
       * @description 修复阶梯中最终成功或失败的一级
       * @enum {string|null}
       */
      repair_step:
        'parse' | 'jsonrepair' | 'validate' | 'field_salvage' | 'reask' | 'next_route' | 'deterministic_only' | null;
      route_id: string;
      seq: number;
      usage: components['schemas']['Usage'];
    };
    /** LocalizedText */
    LocalizedText: {
      en?: string;
      'zh-CN'?: string;
    };
    /** IncidentMember */
    Member: {
      alert_id: string;
      alertname: string;
      component: null | components['schemas']['ComponentKey'];
      ends_at: null | components['schemas']['Timestamp'];
      joined_version: number;
      /** @description 拆分时离开本事件的版本；仍是成员时为 null */
      left_version: number | null;
      role: components['schemas']['AlertRole'];
      severity: components['schemas']['Severity'];
      starts_at: components['schemas']['Timestamp'];
      /** @enum {string} */
      status: 'firing' | 'resolved';
    };
    ModelRouteStatus: {
      base_url_host: string;
      /** @enum {string} */
      breaker: 'closed' | 'open' | 'half_open';
      /** @enum {string|null} */
      breaker_reason: 'failures' | 'latency' | 'failure_domain' | null;
      dialect_profile: string;
      egress_categories: string[];
      failure_domain: components['schemas']['ComponentKey'][];
      health: {
        error_ratio_1h: number | null;
        p50_ms: number | null;
      };
      in_domain: boolean;
      limits: {
        daily_cost: number | null;
        per_incident_cost: number | null;
      };
      model: string;
      price: {
        currency: string;
        input_per_mtok: number;
        output_per_mtok: number;
      };
      provider_fingerprint: string | null;
      provider_retention: string | null;
      route_id: string;
      structured_failure_ratio: number | null;
    };
    /** EvalModelRow */
    ModelRow: {
      benign_false_positive: components['schemas']['Ratio'];
      by_granularity: {
        [key: string]: components['schemas']['Ratio'];
      };
      cost_per_case: {
        currency: string;
        mean: number;
        p90: number;
      };
      /** @description 没有弃权（结论不是 undetermined 或 inconclusive）的运行占比 */
      coverage: components['schemas']['Ratio'];
      disposition_accuracy: components['schemas']['Ratio'];
      model: string;
      /**
       * @description 领域包早于事件或晚于事件，分两组报告
       * @enum {string}
       */
      pack_timing: 'pack_before_incident' | 'pack_after_incident' | 'all';
      /** @description 每个用例第一次运行命中的占比 */
      pass_at_1: components['schemas']['Ratio'];
      /** @description k 次运行全部命中的用例占比（k 为 runs_per_case） */
      pass_pow_k: components['schemas']['Ratio'];
      /** @description 评测期间观察到的服务方指纹；与路由当前指纹不同的成绩作废 */
      provider_fingerprints: string[];
      /** @description 前 3 个候选覆盖根因集合的运行占比 */
      recall_at_3: components['schemas']['Ratio'];
      /** @description 可靠性表：结论阶梯每一档的精确率（DESIGN §14.4）；evidence_consistent 的精确率下界低于 0.85 时该档自动降级 */
      reliability: {
        demoted: boolean;
        level: components['schemas']['ConclusionLevel'];
        precision: components['schemas']['Ratio'];
      }[];
      route_id: string;
      /** @description 同一用例的多次运行给出相同根因与相同处置判断的用例占比 */
      run_agreement: components['schemas']['Ratio'];
      /** @description 不弃权的运行中 top-1 命中的占比 */
      selective_accuracy: components['schemas']['Ratio'];
      snapshot_miss_rate: number | null;
      structured_output_failure: components['schemas']['Ratio'];
      /** @description top-1 落在根因集合内的运行占比（分母为有根因的用例的全部运行） */
      top1: components['schemas']['Ratio'];
      undetermined_ratio: components['schemas']['Ratio'];
    };
    /** NextCheck */
    NextCheck: {
      args: {
        [key: string]: unknown;
      };
      hypothesis_id: string;
      /** @enum {string} */
      outcome: 'not_run' | 'supports' | 'refutes' | 'inconclusive' | 'failed';
      purpose: string;
      refutes_if: string;
      /** @description 控制器执行后得到的卡；未执行时为 null */
      result_ref: null | components['schemas']['EvidenceRef'];
      template: string;
      /** @enum {string} */
      type: 'query' | 'tool';
    };
    /** TopologyNode */
    Node: {
      /** @description 领域包 components.yaml 匹配到的组件类型 */
      component_type: string | null;
      /** @description 集群枢纽（CoreDNS、CNI、apiserver、存储）：只有在出现针对它的证据，或至少 3 个独立依赖方同时失败时才吸收症状 */
      hub: boolean;
      key: components['schemas']['ComponentKey'];
      kind: string;
      labels: components['schemas']['Labels'];
      name: string;
      namespace: string | null;
      uid: string | null;
    };
    /**
     * OutboxOwner
     * @enum {string}
     */
    Owner: 'server' | 'worker';
    /**
     * PackLock
     * @description pack.lock：每个包与用户层的内容哈希；每次研判和评测都记录 lock 本身的哈希
     */
    PackLock: {
      /** @constant */
      api_version: 'srenautix.io/pack-lock/v1';
      layers: {
        digest: components['schemas']['Sha256'];
        path: string;
      }[];
      packs: {
        digest: components['schemas']['Sha256'];
        name: string;
        /** @description builtin、git+<url>@<sha> 或 oci://<ref>@<digest> */
        source: string;
        version: string;
      }[];
    };
    PackStatus: {
      ci: null | {
        passed: boolean;
        report_url: string | null;
      };
      digest: components['schemas']['Sha256'];
      disabled_capabilities: string[];
      /** @enum {string} */
      layer: 'builtin' | 'user';
      load_error: string | null;
      loaded: boolean;
      /** @enum {string} */
      maturity: 'stable' | 'beta' | 'draft';
      name: string;
      ref: string;
      /** @enum {string} */
      source: 'git' | 'oci' | 'builtin';
      user_layer_lines: number | null;
      version: string;
    };
    PauseState: {
      by: string | null;
      expires_at: null | components['schemas']['Timestamp'];
      held_count: number;
      paused: boolean;
      reason: string | null;
      since: null | components['schemas']['Timestamp'];
    };
    /**
     * @description 角色绑定授予的权限名（DESIGN §13）；server 只接受这 16 个取值，其他值返回 400
     * @enum {string}
     */
    Permission:
      | 'read'
      | 'feedback'
      | 'propose'
      | 'research.request'
      | 'evidence.rerun'
      | 'approve'
      | 'reject'
      | 'undo'
      | 'audit.read'
      | 'prompt.raw'
      | 'users.read'
      | 'settings.write'
      | 'suppression.write'
      | 'pause.write'
      | 'eval.write'
      | 'api_tokens.write';
    PermissionTarget: {
      cluster: string;
      labels: components['schemas']['Labels'];
      namespace: string | null;
    };
    /**
     * Principal
     * @description 已认证的主体（DESIGN §10.3 identity 契约输出）
     */
    Principal: {
      display_name: string;
      groups: string[];
      id: string;
    };
    /**
     * @description 安装配置（DESIGN §1.3）
     * @enum {string}
     */
    Profile: 'observe' | 'standard' | 'compliance';
    /**
     * Proposal
     * @description server 持有的提议（DESIGN §2.4、§9）。提交时带幂等键，并绑定 {incident_version, root_component, evidence_fingerprint}；三者任一变化即标为 stale，gateway 执行前经中心再检查一次。审批断言、工单与 ActionExecution 的格式以 contract/gateway/ 为准
     */
    'proposal.schema': {
      /** @description 动作目录中的动作 id */
      action: string;
      /** @description 审批或拒绝的记录；断言本体见 contract/gateway/ */
      approval: null | components['schemas']['ApprovalRecord'];
      /** @description 策略允许自动执行：等级为 reversible 或 reversible_recreatable、在策略允许的命名空间与动作内、未超过每小时上限。自动批准的断言 approver_principal 为 auto:<规则名> */
      auto_eligible: boolean;
      binding: components['schemas']['Binding'];
      /** @description human 为主体 id，external 为调用方 id */
      caller_id: string | null;
      /**
       * @description 参数规范化版本，取值与审批断言的 canon_version 一致：jcs-sha256-v1 表示 RFC 8785 JCS、UTF-8、SHA-256、小写十六进制并带 sha256: 前缀
       * @enum {string}
       */
      canon_version: 'jcs-sha256-v1';
      cluster_id: components['schemas']['ClusterId'];
      created_at: components['schemas']['Timestamp'];
      evidence_refs: components['schemas']['EvidenceRef'][];
      /** @description gateway 推回的 ActionExecution 摘要；phase 取值以 contract/gateway/ 的 ActionExecution 为准 */
      execution: null | components['schemas']['ExecutionSummary'];
      expected_effect: string;
      first_delivered_at: null | components['schemas']['Timestamp'];
      hypothesis_id: string | null;
      /** @description sha256(JCS([incident_id, run_id 或 rule_id 或 caller_id, action, canonical_params])) */
      idempotency_key: components['schemas']['Sha256'];
      incident_id: components['schemas']['Uuid'];
      /**
       * @description 动作等级（DESIGN §9.1），取值与 contract/gateway/v1/approval-assertion 的 level 一致（packages/contract 的测试核对）；满足可重建条件的 pod_restart 为 reversible_recreatable
       * @enum {string}
       */
      level: 'reversible' | 'reversible_recreatable' | 'compensable' | 'irreversible';
      params: {
        [key: string]: unknown;
      };
      params_hash: components['schemas']['Sha256'];
      policy_checks: {
        detail: string;
        name: string;
        passed: boolean;
      }[];
      proposal_id: components['schemas']['Uuid'];
      research_run_id: null | components['schemas']['Uuid'];
      /** @description <pack>/<rule id> */
      rule_id: string | null;
      /**
       * @description research：阶段 B 研判；rule：领域包规则提议；human：控制台人工提议；external：MCP 或 API 调用方（只能提议）
       * @enum {string}
       */
      source: 'research' | 'rule' | 'human' | 'external';
      state: components['schemas']['State'];
      target: components['schemas']['Target'];
      /**
       * @description 审批档位（DESIGN §9.2），取值与审批断言的 tier 一致
       * @enum {string}
       */
      tier: 'L' | 'H';
      /** @description 提议 TTL 从第一次成功送达时开始计算，并且有硬上限；未送达时为 null */
      ttl_expires_at: null | components['schemas']['Timestamp'];
      updated_at: components['schemas']['Timestamp'];
      $defs: {
        /** ProposalBinding */
        Binding: {
          evidence_fingerprint: components['schemas']['Sha256'];
          incident_version: number;
          root_component: components['schemas']['ComponentKey'];
        };
        /**
         * ProposalTarget
         * @description 由机器从事件与动作的目标解析规则推导，模型给出的目标必须等于推导结果
         */
        Target: {
          cluster_id: components['schemas']['ClusterId'];
          /** @description H 档审批时要输入的目标名 */
          display: string;
          kind: string;
          name: string;
          namespace: string | null;
          uid: string | null;
        };
        /**
         * ProposalState
         * @description rejected_by_policy 策略拒绝；awaiting_approval 待审批；approved 已签发审批断言、等待 gateway 拉取；dispatched gateway 已拉取，后续进度见 execution；rejected 人工拒绝；expired TTL 或审批过期；stale 绑定字段变化；duplicate 与未结束的提议幂等键相同；held 被软暂停扣住
         * @enum {string}
         */
        State:
          | 'rejected_by_policy'
          | 'awaiting_approval'
          | 'approved'
          | 'held'
          | 'dispatched'
          | 'rejected'
          | 'expired'
          | 'stale'
          | 'duplicate';
        /** ApprovalRecord */
        ApprovalRecord: {
          /** @description 签发的审批断言 id；拒绝时为 null */
          assertion_id: null | components['schemas']['Uuid'];
          at: components['schemas']['Timestamp'];
          /**
           * @description Channel 的取值，或策略自动批准时的 auto
           * @enum {string}
           */
          channel:
            'console' | 'grafana' | 'telegram' | 'feishu' | 'dingtalk' | 'wecom' | 'slack' | 'api' | 'mcp' | 'auto';
          /** @enum {string} */
          decision: 'approved' | 'rejected' | 'auto';
          principal_id: string;
          reason: string | null;
        };
        /** ExecutionSummary */
        ExecutionSummary: {
          execution_id: string;
          phase: string;
          queue_position: number | null;
          updated_at: components['schemas']['Timestamp'];
        };
        /**
         * ProposalCreate
         * @description 提交提议的请求体。source、caller_id 由认证上下文决定；目标由 server 推导
         */
        ProposalCreate: {
          action: string;
          binding: components['schemas']['Binding'];
          evidence_refs: components['schemas']['EvidenceRef'][];
          expected_effect: string;
          hypothesis_id: string | null;
          incident_id: components['schemas']['Uuid'];
          params: {
            [key: string]: unknown;
          };
          research_run_id: null | components['schemas']['Uuid'];
          rule_id: string | null;
        };
      };
    };
    /** ProposalChangedEvent */
    ProposalChanged: {
      payload: components['schemas']['proposal.schema'];
      /** @enum {unknown} */
      type: 'proposal.created' | 'proposal.updated';
    } & components['schemas']['Header'];
    /**
     * ProposalCreate
     * @description 提交提议的请求体。source、caller_id 由认证上下文决定；目标由 server 推导
     */
    ProposalCreate: {
      action: string;
      binding: components['schemas']['Binding'];
      evidence_refs: components['schemas']['EvidenceRef'][];
      expected_effect: string;
      hypothesis_id: string | null;
      incident_id: components['schemas']['Uuid'];
      params: {
        [key: string]: unknown;
      };
      research_run_id: null | components['schemas']['Uuid'];
      rule_id: string | null;
    };
    ProposalDetail: {
      blast_radius: {
        objects: string[];
        summary: string;
        within_limit: boolean;
      };
      conflict_domain: string;
      /** @description 模型给出的理由，标注"模型生成，未经验证"；规则或人工提议时为 null */
      model_rationale: string | null;
      /** @description 决定审批档位的策略规则 */
      policy_rule: string;
      prechecked_at: components['schemas']['Timestamp'];
      prechecks: {
        detail: string;
        name: string;
        passed: boolean;
      }[];
      proposal: components['schemas']['proposal.schema'];
      queue_position: number | null;
      target_state: {
        exists: boolean;
        resource_version: string | null;
        /** @description 例如副本数、就绪数、cordon 状态 */
        summary: string;
        uid: string | null;
      };
      undo: {
        description: string;
        /** @enum {string} */
        kind: 'auto_restore' | 'controller_rebuild' | 'compensation' | 'none';
      };
      verify: {
        condition: string;
        window: components['schemas']['Duration'];
      };
    };
    /**
     * ProposalDraft
     * @description 研判产生的提议草稿，经 server 的提议中转写入 proposals
     */
    ProposalDraft: {
      action_id: string;
      expected_effect: string;
      hypothesis_id: string;
      params: {
        [key: string]: unknown;
      };
      /** @description 提议中转接受后的 id；被拒绝时为 null */
      proposal_id: null | components['schemas']['Uuid'];
    };
    /**
     * EdgeProvenance
     * @description 边的来源（DESIGN §4.2）
     * @enum {string}
     */
    Provenance: 'structural' | 'runtime' | 'config_ref' | 'network_policy' | 'naming';
    /** EvidenceQueryRecord */
    QueryRecord: {
      capability: string;
      duration_ms: number;
      error: string | null;
      /** @description 集成实例 id */
      integration: string;
      name: string;
      /** @description 实际执行的查询文本 */
      query: string;
      sample_count: number;
      truncated: boolean;
    };
    /** EvalRatio */
    Ratio: {
      ci_high: number | null;
      /** @description 聚类自助法 90% 置信区间下界 */
      ci_low: number | null;
      denominator: number;
      numerator: number;
      value: number | null;
    };
    /** EvidenceReason */
    Reason: {
      /**
       * @description rule：命中判定规则；no_data：查询没有样本；partial_data：部分查询没有样本；source_error：数据源报错或超时；capability_missing：所需能力不可用；observability_gap：依赖的目标有 meta 告警；evaluation_error：CEL 求值出错；all_clear：没有命中任何规则；model_judged：只读工具的结果没有 CEL 判定，由小模型对照 refutes_if 判定（可以支持 likely，不能单独支撑 evidence_consistent，展示时标注模型判定）
       * @enum {string}
       */
      kind:
        | 'rule'
        | 'no_data'
        | 'partial_data'
        | 'source_error'
        | 'capability_missing'
        | 'observability_gap'
        | 'evaluation_error'
        | 'all_clear'
        | 'model_judged';
      text: string;
    };
    /** @description H 档服务签名必须携带的重新认证凭据（OIDC max_age）。auth_time 不晚于 assertion.issued_at，且两者相差不超过 300 秒。 */
    reauth: {
      auth_time: string;
      /** @enum {string} */
      method: 'oidc_max_age' | 'local_totp';
      /** @description "sha256:" 加服务端会话 ID 的 SHA-256，用于在治理审计链中关联会话。 */
      session_hash: string;
    };
    /** Recommendation */
    Recommendation: {
      action_id: string | null;
      evidence_refs: components['schemas']['EvidenceRef'][];
      /**
       * @description model 的建议在消息与控制台中标注模型生成
       * @enum {string}
       */
      generated_by: 'model' | 'rule';
      hypothesis_id: string;
      id: string;
      /** @enum {string} */
      kind: 'mitigation' | 'root_fix' | 'prevention' | 'investigation';
      /** @enum {string} */
      owner: 'platform' | 'app' | 'vendor' | 'oncall';
      rationale: string;
      /** @enum {string} */
      risk: 'low' | 'medium' | 'high';
      risk_note: string | null;
      runbook_ref: string | null;
      steps: string[];
      title: string;
    };
    /**
     * ResearchManifest
     * @description 研判清单（DESIGN §8.5）：复现一次研判需要的全部版本信息，以及出境清单（§8.4）。后处理部分可以基于已保存的响应精确重放；重新采样模型得到的是一个分布
     */
    'research-manifest.schema': {
      code_sha: string;
      contract_version: string;
      /** @description 出境清单：每次出站模型请求带出了哪些类别的数据 */
      egress: components['schemas']['EgressEntry'][];
      /** @description 研判运行内的证据引用（card:n、alert:n、change:n）到定义与实体的映射 */
      evidence_map: {
        ref: components['schemas']['EvidenceRef'];
        /** @description card_id@实体键、alert_id 或 change_id */
        target: string;
      }[];
      incident_id: components['schemas']['Uuid'];
      incident_version: number;
      pack_lock: components['schemas']['Sha256'];
      /** @description 阶段名 → 提示词哈希 */
      prompt_hashes: {
        [key: string]: components['schemas']['Sha256'];
      };
      redaction_version: string;
      retrieved_cases: string[];
      retrieved_knowledge: string[];
      routes: components['schemas']['RouteUse'][];
      run_id: components['schemas']['Uuid'];
      snapshot_id: null | components['schemas']['Uuid'];
      topology_version: number;
      $defs: {
        /** RouteUse */
        RouteUse: {
          dialect_profile: string;
          model: string;
          /** @enum {string} */
          phase: 'hypothesize' | 'conclude' | 'compress' | 'still_consistent' | 'repair';
          provider_fingerprint: string | null;
          route_id: string;
          sampling: {
            [key: string]: number | string | boolean;
          };
          seed: number | null;
        };
        /** EgressEntry */
        EgressEntry: {
          bytes: number;
          categories: ('metrics' | 'logs' | 'traces' | 'events' | 'topology' | 'changes' | 'alerts' | 'knowledge')[];
          in_domain: boolean;
          redaction_hits: number;
          route_id: string;
        };
      };
    };
    /**
     * ResearchOutput
     * @description 一次研判经代码校验后的输出（DESIGN §7.2、§7.3），由 worker 写入 research_runs 并随 research.concluded 发布。模型直接输出的部分见 contract/model/；本结构加入假设账本状态、区分性检查结果、代码判定的结论阶梯和校验记录
     */
    'research-output.schema': {
      conclusion: components['schemas']['Conclusion'];
      disposition: components['schemas']['Disposition'];
      hypotheses: components['schemas']['Hypothesis'][];
      next_checks: components['schemas']['NextCheck'][];
      proposals: components['schemas']['ProposalDraft'][];
      recommendations: components['schemas']['Recommendation'][];
      situation: string;
      summary: string;
      /** @description 代码校验的修改记录：删除的无效证据引用、删除的目录外提议、降级的结论等 */
      validation_notes: string[];
      $defs: {
        /** ResearchConclusion */
        Conclusion: {
          consistency: components['schemas']['ConsistencyChecks'];
          hypothesis_id: string | null;
          level: components['schemas']['ConclusionLevel'];
          root_component: null | components['schemas']['ComponentKey'];
          undetermined_reason: string | null;
        };
        /**
         * ConsistencyChecks
         * @description evidence_consistent 的四个条件逐项结果（DESIGN §7.3）；四项全为 true 才是 evidence_consistent
         */
        ConsistencyChecks: {
          competitor_tested: boolean;
          entity_in_scope: boolean;
          no_contrary_normal: boolean;
          onset_precedes_symptom: boolean;
        };
        /** Hypothesis */
        Hypothesis: {
          id: string;
          mechanism: string;
          parent_id: string | null;
          refuting: components['schemas']['EvidenceRef'][];
          root_component: components['schemas']['ComponentKey'];
          /**
           * @description 假设账本状态：pending 待检验；supported 支持；refuted 推翻；inconclusive 检验后仍无法判定
           * @enum {string}
           */
          status: 'pending' | 'supported' | 'refuted' | 'inconclusive';
          supporting: components['schemas']['EvidenceRef'][];
        };
        /** NextCheck */
        NextCheck: {
          args: {
            [key: string]: unknown;
          };
          hypothesis_id: string;
          /** @enum {string} */
          outcome: 'not_run' | 'supports' | 'refutes' | 'inconclusive' | 'failed';
          purpose: string;
          refutes_if: string;
          /** @description 控制器执行后得到的卡；未执行时为 null */
          result_ref: null | components['schemas']['EvidenceRef'];
          template: string;
          /** @enum {string} */
          type: 'query' | 'tool';
        };
        /** Recommendation */
        Recommendation: {
          action_id: string | null;
          evidence_refs: components['schemas']['EvidenceRef'][];
          /**
           * @description model 的建议在消息与控制台中标注模型生成
           * @enum {string}
           */
          generated_by: 'model' | 'rule';
          hypothesis_id: string;
          id: string;
          /** @enum {string} */
          kind: 'mitigation' | 'root_fix' | 'prevention' | 'investigation';
          /** @enum {string} */
          owner: 'platform' | 'app' | 'vendor' | 'oncall';
          rationale: string;
          /** @enum {string} */
          risk: 'low' | 'medium' | 'high';
          risk_note: string | null;
          runbook_ref: string | null;
          steps: string[];
          title: string;
        };
        /**
         * ProposalDraft
         * @description 研判产生的提议草稿，经 server 的提议中转写入 proposals
         */
        ProposalDraft: {
          action_id: string;
          expected_effect: string;
          hypothesis_id: string;
          params: {
            [key: string]: unknown;
          };
          /** @description 提议中转接受后的 id；被拒绝时为 null */
          proposal_id: null | components['schemas']['Uuid'];
        };
      };
    };
    /** ResearchConcludedEvent */
    ResearchConcluded: {
      payload: {
        evidence_fingerprint: components['schemas']['Sha256'];
        incident_id: components['schemas']['Uuid'];
        incident_version: number;
        output: components['schemas']['research-output.schema'];
        run_id: components['schemas']['Uuid'];
      };
      /** @constant */
      type: 'research.concluded';
    } & components['schemas']['Header'];
    /** ResearchFailedEvent */
    ResearchFailed: {
      payload: {
        incident_id: components['schemas']['Uuid'];
        incident_version: number;
        /** @enum {string} */
        kind:
          | 'model_unavailable'
          | 'breaker_open'
          | 'budget_exhausted'
          | 'deadline'
          | 'invalid_output'
          | 'datasource'
          | 'internal';
        message: string;
        run_id: components['schemas']['Uuid'];
      };
      /** @constant */
      type: 'research.failed';
    } & components['schemas']['Header'];
    /** ResearchQueuedEvent */
    ResearchQueued: {
      payload: {
        incident_id: components['schemas']['Uuid'];
        incident_version: number;
        reason: components['schemas']['ResearchReason'];
        run_id: components['schemas']['Uuid'];
      };
      /** @constant */
      type: 'research.queued';
    } & components['schemas']['Header'];
    /**
     * ResearchReason
     * @description 触发研判的原因；(incident_id, incident_version, reason) 是触发的唯一键
     * @enum {string}
     */
    ResearchReason:
      | 'new_incident'
      | 'fingerprint_changed'
      | 'root_changed'
      | 'severity_raised'
      | 'feedback'
      | 'manual'
      | 'model_recovered'
      | 'resumed';
    ResearchRun: {
      budget: {
        cost: number;
        currency: string;
        estimated_input_tokens: number;
        input_tokens: number;
        output_tokens: number;
      };
      conclusion_level: null | components['schemas']['ConclusionLevel'];
      disposition: null | components['schemas']['Disposition'];
      error: null | {
        kind: string;
        message: string;
      };
      /** @description 本次研判的全部证据卡结果（含区分性检查产生的卡） */
      evidence: components['schemas']['evidence-result.schema'][];
      finished_at: null | components['schemas']['Timestamp'];
      incident_id: components['schemas']['Uuid'];
      incident_version: number;
      llm_calls: components['schemas']['LlmCall'][];
      output: null | components['schemas']['research-output.schema'];
      reason: components['schemas']['ResearchReason'];
      root_component: null | components['schemas']['ComponentKey'];
      run_id: components['schemas']['Uuid'];
      started_at: components['schemas']['Timestamp'];
      state: components['schemas']['ResearchState'];
      /** @description 状态机每一步的起止时间，供运行明细的瀑布图使用 */
      steps: {
        finished_at: null | components['schemas']['Timestamp'];
        started_at: components['schemas']['Timestamp'];
        state: components['schemas']['ResearchState'];
      }[];
      /** @enum {string|null} */
      stop_reason: 'leader_supported' | 'no_change' | 'step_limit' | 'deadline' | 'budget' | 'model_unavailable' | null;
      summary: string | null;
      tool_calls: components['schemas']['ToolCall'][];
    };
    ResearchRunSummary: {
      conclusion_level: null | components['schemas']['ConclusionLevel'];
      disposition: null | components['schemas']['Disposition'];
      finished_at: null | components['schemas']['Timestamp'];
      incident_id: components['schemas']['Uuid'];
      incident_version: number;
      reason: components['schemas']['ResearchReason'];
      root_component: null | components['schemas']['ComponentKey'];
      run_id: components['schemas']['Uuid'];
      started_at: components['schemas']['Timestamp'];
      state: components['schemas']['ResearchState'];
      summary: string | null;
    };
    /**
     * @description queued 已入队；hypothesize / discriminate / conclude 阶段 B 的三步；completed 完成；
     *     stage_a_only 跳过阶段 B（熔断、预算、风暴、故障域）；failed 失败；superseded 被同一事件更新的触发取代
     * @enum {string}
     */
    ResearchState:
      'queued' | 'hypothesize' | 'discriminate' | 'conclude' | 'completed' | 'stage_a_only' | 'failed' | 'superseded';
    /** @enum {string} */
    role: 'viewer' | 'responder' | 'approver' | 'auditor' | 'admin' | 'sys-admin' | 'security-admin';
    /**
     * RoleBinding
     * @description (主体, 角色, 作用域)，来自 Git
     */
    RoleBinding: {
      /**
       * @description approver 的风险上限
       * @enum {string}
       */
      max_risk_tier?: 'L' | 'H';
      /** @enum {string} */
      role: 'viewer' | 'responder' | 'approver' | 'auditor' | 'admin' | 'sys-admin' | 'security-admin';
      scope: {
        clusters: string[];
        component_labels: components['schemas']['Labels'];
        namespaces: string[];
      };
      subject: {
        /** @enum {string} */
        kind: 'user' | 'group';
        name: string;
      };
    };
    /** IncidentRoot */
    Root: {
      /** @description 第一与第二候选的分差小于 δ（默认 0.1）；两个候选的证据链都执行 */
      ambiguous: boolean;
      /** @description 排名第一的候选；没有候选时为 null */
      component: null | components['schemas']['ComponentKey'];
      entity: null | components['schemas']['EntityRef'];
      /** @description 第一与第二候选的分差；只有一个候选时为 null */
      margin: number | null;
      /** @description 根因由沉默根因探测卡加入，没有指向它的告警 */
      silent_root: boolean;
    };
    /** RootCandidate */
    RootCandidate: {
      component: components['schemas']['ComponentKey'];
      /** @description 在折叠强连通分量后的依赖图上的深度，只用于平分时排序 */
      depth: number;
      /** @description 能解释的症状告警 alert_id */
      explains: string[];
      score: number;
      /**
       * @description alert：有指向它的 cause/change 告警；change：有触及它的变更；hub：没有告警的集群枢纽，至少 3 个独立依赖方同时出现告警；probe：沉默根因探测卡异常；symptom：只有症状告警
       * @enum {string}
       */
      source: 'alert' | 'change' | 'hub' | 'probe' | 'symptom';
      terms: components['schemas']['ScoreTerms'];
    };
    /** RouteUse */
    RouteUse: {
      dialect_profile: string;
      model: string;
      /** @enum {string} */
      phase: 'hypothesize' | 'conclude' | 'compress' | 'still_consistent' | 'repair';
      provider_fingerprint: string | null;
      route_id: string;
      sampling: {
        [key: string]: number | string | boolean;
      };
      seed: number | null;
    };
    scope: {
      clusters: string[];
      component_labels: components['schemas']['Labels'];
      namespaces: string[];
    };
    /**
     * RootScoreTerms
     * @description 根因得分的各项（DESIGN §5），每项在 [0,1] 内，乘以 rca-params 中的权重后求和
     */
    ScoreTerms: {
      chronic_penalty: number;
      coverage: number;
      precedence: number;
      recent_change: number;
      role_prior: number;
    };
    /** @description 服务签名。签名输入为 ASCII "srenautix-approval-v1" 加一个换行符 0x0A，再接 JCS(statement) 的 UTF-8 字节；statement 为 {"assertion": assertion}，H 档时为 {"assertion": assertion, "reauth": reauth}。 */
    serviceProof: {
      /** @description 服务签名公钥的 ID，对应 approver-keys 中 use=service 的条目。 */
      key_id: string;
      reauth?: components['schemas']['reauth'];
      /** @description Ed25519 签名（64 字节）的 base64url。 */
      signature: components['schemas']['base64url'];
      /** @constant */
      type: 'service_ed25519';
    };
    Session: {
      /** @description 最近一次认证或重新认证的时间；H 档审批要求在 5 分钟内 */
      auth_time: components['schemas']['Timestamp'];
      /** @description 本地管理员作为紧急入口登录；页面显示横幅 */
      break_glass: boolean;
      csrf_token: string;
      expires_at: components['schemas']['Timestamp'];
      local_admin: boolean;
      principal: components['schemas']['Principal'];
      profile: components['schemas']['Profile'];
      provider: string;
      /** @description 角色绑定与作用域 */
      roles: components['schemas']['RoleBinding'][];
    };
    Settings: {
      channels: {
        enabled: boolean;
        id: string;
        kind: components['schemas']['Channel'];
        rate_per_min: number;
        target: string;
      }[];
      /** @enum {string} */
      locale: 'zh-CN' | 'en';
      retention: {
        incidents_days: number;
        raw_prompt_days: number;
        research_days: number;
      };
      subscriptions: {
        channel_id: string;
        filter: {
          cluster_id: string | null;
          component: string | null;
          /** @enum {string|null} */
          severity: 'critical' | 'warning' | 'info' | null;
        };
        id: string;
      }[];
      time_zone: string;
    };
    /**
     * Severity
     * @enum {string}
     */
    Severity: 'critical' | 'warning' | 'info';
    sha256: string;
    /** Sha256 */
    Sha256: string;
    SpokeStatus: {
      /**
       * @description 只对 gateway 有意义
       * @enum {string|null}
       */
      admission_selfcheck: 'passed' | 'failed' | 'unknown' | null;
      connected: boolean;
      last_seen_at: null | components['schemas']['Timestamp'];
      version: string | null;
    };
    /**
     * StageAReport
     * @description 阶段 A 的确定性报告（DESIGN §7.1）：不调用模型，不经过 worker。事件创建或版本变化后立即生成
     */
    'stage-a-report.schema': {
      ambiguous: boolean;
      candidates: components['schemas']['RootCandidate'][];
      /** @description 证据卡的判定向量；正常卡表示被排除嫌疑 */
      cards: components['schemas']['evidence-result.schema'][];
      /** @description 状态库降级：PG 不可用时在内存中生成，消息带降级横幅 */
      degraded: boolean;
      disposition: components['schemas']['Disposition'];
      /**
       * @description suppressed：命中抑制规则；pack_exclude：命中领域包的排除规则；forecast_or_chronic_only：只有 forecast 和长期告警；rule_action：有动作明确的规则提议；critical_ambiguous：critical 且根因有歧义；observability_blind：观测失明；default：其余情况
       * @enum {string}
       */
      disposition_reason:
        | 'suppressed'
        | 'pack_exclude'
        | 'forecast_or_chronic_only'
        | 'rule_action'
        | 'critical_ambiguous'
        | 'observability_blind'
        | 'default';
      /** @description 判定向量的指纹（带迟滞，见 docs/core/convergence.md） */
      evidence_fingerprint: components['schemas']['Sha256'];
      incident_id: components['schemas']['Uuid'];
      incident_version: number;
      observability_blind: boolean;
      rendered_at: components['schemas']['Timestamp'];
      report_id: components['schemas']['Uuid'];
      rule_proposals: components['schemas']['Uuid'][];
      runbooks: string[];
      timeline: {
        at: components['schemas']['Timestamp'];
        /** @enum {string} */
        kind: 'alert_firing' | 'alert_resolved' | 'change' | 'card_abnormal';
        ref: string | null;
        text: string;
      }[];
    };
    /** StageAReportedEvent */
    StageAReported: {
      payload: {
        /** @description 状态库降级时在内存中生成 */
        degraded: boolean;
        disposition: components['schemas']['Disposition'];
        evidence_fingerprint: components['schemas']['Sha256'];
        incident_id: components['schemas']['Uuid'];
        incident_version: number;
        report_id: components['schemas']['Uuid'];
      };
      /** @constant */
      type: 'stage_a.reported';
    } & components['schemas']['Header'];
    /**
     * ProposalState
     * @description rejected_by_policy 策略拒绝；awaiting_approval 待审批；approved 已签发审批断言、等待 gateway 拉取；dispatched gateway 已拉取，后续进度见 execution；rejected 人工拒绝；expired TTL 或审批过期；stale 绑定字段变化；duplicate 与未结束的提议幂等键相同；held 被软暂停扣住
     * @enum {string}
     */
    State:
      | 'rejected_by_policy'
      | 'awaiting_approval'
      | 'approved'
      | 'held'
      | 'dispatched'
      | 'rejected'
      | 'expired'
      | 'stale'
      | 'duplicate';
    Subgraph: {
      edges: {
        confidence: number;
        from: components['schemas']['ComponentKey'];
        provenance: components['schemas']['Provenance'];
        relation: string;
        /** @enum {string} */
        scope: 'instance' | 'service';
        to: components['schemas']['ComponentKey'];
      }[];
      nodes: {
        /** @description 该组件上的成员告警 alert_id */
        alerts: string[];
        component: components['schemas']['ComponentKey'];
        hops: number;
        kind: string;
        name: string;
        namespace: string | null;
        /** @enum {string} */
        role: 'root' | 'candidate' | 'member' | 'neighbor';
      }[];
      root: null | components['schemas']['ComponentKey'];
      topology_version: number;
    };
    subject: {
      /** @enum {string} */
      kind: 'user' | 'group';
      name: string;
    };
    target: {
      group: string;
      kind: string;
      /** @description 目标可以是多种类型时列出全部（例如 Deployment 与 StatefulSet）。 */
      kinds?: {
        group: string;
        kind: string;
        resource: string;
        version: string;
      }[];
      namespaced: boolean;
      resource: string;
      version: string;
    };
    /**
     * ProposalTarget
     * @description 由机器从事件与动作的目标解析规则推导，模型给出的目标必须等于推导结果
     */
    Target: {
      cluster_id: components['schemas']['ClusterId'];
      /** @description H 档审批时要输入的目标名 */
      display: string;
      kind: string;
      name: string;
      namespace: string | null;
      uid: string | null;
    };
    /** @enum {string} */
    tier: 'L' | 'H';
    TimelineEntry: {
      at: components['schemas']['Timestamp'];
      /** @enum {string} */
      kind:
        | 'alert_firing'
        | 'alert_resolved'
        | 'change'
        | 'card_abnormal'
        | 'incident_merged'
        | 'incident_split'
        | 'stage_a'
        | 'research_concluded'
        | 'proposal'
        | 'execution'
        | 'feedback';
      /** @description 关联对象的 id（alert_id、change_id、run_id、proposal_id 等） */
      ref: string | null;
      text: string;
      /** @description text 含告警、日志或变更来源的原文，只作为文本显示 */
      untrusted: boolean;
    };
    timestamp: string;
    /**
     * Timestamp
     * Format: date-time
     * @description RFC 3339 UTC 时间
     */
    Timestamp: string;
    /** TimeWindow */
    TimeWindow: {
      from: components['schemas']['Timestamp'];
      to: components['schemas']['Timestamp'];
    };
    ToolCall: {
      arguments: {
        [key: string]: unknown;
      };
      /** @description 开始时间 */
      at: components['schemas']['Timestamp'];
      duration_ms: number;
      error: string | null;
      limit_applied: number | null;
      /** @description 工具结果判定成的卡 */
      result_ref: null | components['schemas']['EvidenceRef'];
      result_size: number;
      seq: number;
      tool: string;
      truncated: boolean;
      window: null | components['schemas']['TimeWindow'];
    };
    TopologyCoverage: {
      components: {
        chains: string[];
        component: components['schemas']['ComponentKey'];
        /** @enum {string} */
        discovered_by: 'informer' | 'ksm_history' | 'pack' | 'user' | 'runtime';
        mapped_alerts: string[];
        type: string | null;
      }[];
      components_without_chains: components['schemas']['ComponentKey'][];
      suggestions: string[];
      topology_version: number;
      /** @description 14 天内出现过、没有映射到组件的告警名 */
      unmapped_alerts: {
        alertname: string;
        confidence: number;
        count_14d: number;
        expr: string | null;
        suggested_component: null | components['schemas']['ComponentKey'];
        suggested_role: components['schemas']['AlertRole'];
      }[];
    };
    /**
     * ModelUsage
     * @description 计量依据服务方返回的 usage
     */
    Usage: {
      cached_input_tokens: number;
      input_tokens: number;
      output_tokens: number;
      reasoning_tokens: number;
    };
    /**
     * Uuid
     * Format: uuid
     */
    Uuid: string;
    /**
     * Verdict
     * @description 证据卡的三种结论
     * @enum {string}
     */
    Verdict: 'normal' | 'abnormal' | 'undeterminable';
    /** @description 通行密钥签名（WebAuthn Level 3 断言）。clientDataJSON 的 type 为 webauthn.get，challenge 为 sha256(JCS(assertion)) 原始 32 字节的 base64url；签名覆盖 authenticatorData 与 sha256(clientDataJSON) 的拼接。签名算法由 approver-keys 中该凭据的 alg 决定：EdDSA 为 64 字节 Ed25519 签名，ES256 为 DER 编码的 ECDSA 签名。type 取 webauthn；webauthn_ed25519 只能用于 alg 为 EdDSA 的凭据，用于其他凭据时拒绝（webauthn_alg_mismatch）。 */
    webauthnProof: {
      authenticator_data: components['schemas']['base64url'];
      client_data_json: components['schemas']['base64url'];
      credential_id: components['schemas']['base64url'];
      /** @description EdDSA：64 字节（86 个字符）；ES256：DER 编码的 ECDSA-Sig-Value，至多 72 字节（96 个字符）。 */
      signature: components['schemas']['base64url'];
      /** @enum {string} */
      type: 'webauthn' | 'webauthn_ed25519';
    };
  };
  responses: {
    /** @description 错误 */
    Error: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        'application/json': components['schemas']['Error'];
      };
    };
  };
  parameters: {
    Csrf: string;
    /** @description 会话认证时必填；Bearer 认证时不需要 */
    CsrfOptional: string;
    /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
    IncidentRef: string;
    /** @description 只用于 Grafana 插件 token：Grafana 用户的邮箱 */
    OnBehalfOf: string;
    ProposalId: components['schemas']['Uuid'];
    RunId: components['schemas']['Uuid'];
  };
  requestBodies: never;
  headers: never;
  pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
  getHealthz: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 进程存活 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
    };
  };
  getReadyz: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 迁移完成，可以服务 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      503: components['responses']['Error'];
    };
  };
  getAgentCost: {
    parameters: {
      query: {
        from?: string;
        group_by: 'day' | 'incident' | 'model';
        to?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 成本 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            currency: string;
            daily_budget: number | null;
            items: {
              cost: number;
              input_tokens: number;
              key: string;
              label: string;
              output_tokens: number;
              runs: number;
            }[];
          };
        };
      };
    };
  };
  getAgentHealth: {
    parameters: {
      query?: {
        window?: components['schemas']['Duration'];
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 记分卡 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['AgentHealth'];
        };
      };
    };
  };
  listApiTokens: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description API token（只有提议权限） */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ApiToken'][];
        };
      };
    };
  };
  createApiToken: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          expires_at: null | components['schemas']['Timestamp'];
          name: string;
        };
      };
    };
    responses: {
      /** @description 明文 token 只在这里返回一次 */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            api_token: components['schemas']['ApiToken'];
            token: string;
          };
        };
      };
    };
  };
  deleteApiToken: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path: {
        token_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 已删除 */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      404: components['responses']['Error'];
    };
  };
  batchApprove: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          proposal_ids: components['schemas']['Uuid'][];
        };
      };
    };
    responses: {
      /** @description 逐项结果 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            results: components['schemas']['ApprovalOutcome'][];
          };
        };
      };
      400: components['responses']['Error'];
    };
  };
  listAuditChains: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 执行链（每个集群一条）与治理链 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @enum {string} */
            chain: 'execution' | 'governance';
            cluster_id: null | components['schemas']['ClusterId'];
            export_lag_seconds: number | null;
            head_hash: string | null;
            head_seq: number;
            lag_threshold_seconds: number;
            sink: {
              /** @enum {string} */
              kind: 's3' | 'minio' | 'pg';
              location: string;
              retention_days: number | null;
              worm: boolean;
            };
            verified: {
              at: null | components['schemas']['Timestamp'];
              error: string | null;
              ok: boolean;
            };
          }[];
        };
      };
    };
  };
  listAuditRecords: {
    parameters: {
      query: {
        chain: 'execution' | 'governance';
        cluster_id?: components['schemas']['ClusterId'];
        cursor?: string;
        limit?: number;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 审计记录 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            items: {
              [key: string]: unknown;
            }[];
            next_cursor: string | null;
          };
        };
      };
    };
  };
  createLinkCode: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 绑定码 */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            code: string;
            expires_at: components['schemas']['Timestamp'];
          };
        };
      };
    };
  };
  loginLocal: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          password: string;
          totp: string;
          username: string;
        };
      };
    };
    responses: {
      /** @description 已登录 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Session'];
        };
      };
      401: components['responses']['Error'];
      423: components['responses']['Error'];
    };
  };
  logout: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 已退出 */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
    };
  };
  oidcCallback: {
    parameters: {
      query: {
        code: string;
        state: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 设置会话后跳回 */
      302: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      400: components['responses']['Error'];
    };
  };
  startOidc: {
    parameters: {
      query?: {
        /** @description 重新认证时传 0，用于 H 档审批（5 分钟内重新认证） */
        max_age?: number;
        return_to?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 跳转到身份提供方 */
      302: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
    };
  };
  listAuthProviders: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 登录方式 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            local_admin: {
              /** @description SSO 已验证通过，本地管理员只作为紧急入口 */
              break_glass: boolean;
              enabled: boolean;
            };
            oidc: null | {
              display_name: string;
            };
            profile: components['schemas']['Profile'];
          };
        };
      };
    };
  };
  reauthLocal: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          password: string;
          totp: string;
        };
      };
    };
    responses: {
      /** @description 已重新认证 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Session'];
        };
      };
      401: components['responses']['Error'];
      423: components['responses']['Error'];
    };
  };
  getSession: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 当前会话 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Session'];
        };
      };
      401: components['responses']['Error'];
    };
  };
  webauthnAssertionOptions: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          proposal_id: components['schemas']['Uuid'];
        };
      };
    };
    responses: {
      /** @description PublicKeyCredentialRequestOptionsJSON */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            [key: string]: unknown;
          };
        };
      };
      404: components['responses']['Error'];
      409: components['responses']['Error'];
    };
  };
  listCatalogActions: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 动作目录 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            catalog: components['schemas']['action-catalog.schema'];
            enabled: {
              action: string;
              auto: boolean;
              cluster_id: components['schemas']['ClusterId'];
              namespaces: string[];
            }[];
          };
        };
      };
    };
  };
  listChatLinks: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 绑定 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ChatLink'][];
        };
      };
    };
  };
  deleteChatLink: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path: {
        channel: components['schemas']['Channel'];
        channel_user_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 已解除 */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      403: components['responses']['Error'];
      404: components['responses']['Error'];
    };
  };
  listClusters: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 集群 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Cluster'][];
        };
      };
    };
  };
  getCluster: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        cluster_id: components['schemas']['ClusterId'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 集群详情 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Cluster'];
        };
      };
      404: components['responses']['Error'];
    };
  };
  listConditions: {
    parameters: {
      query?: {
        cluster_id?: components['schemas']['ClusterId'];
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 当前条件 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['condition.schema'][];
        };
      };
      401: components['responses']['Error'];
    };
  };
  getEgressLedger: {
    parameters: {
      query?: {
        from?: string;
        route_id?: string;
        to?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 出境账本 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            at: components['schemas']['Timestamp'];
            bytes: number;
            categories: string[];
            in_domain: boolean;
            incident_id: components['schemas']['Uuid'];
            redaction_hits: number;
            route_id: string;
            run_id: components['schemas']['Uuid'];
          }[];
        };
      };
    };
  };
  listEvalCases: {
    parameters: {
      query?: {
        cursor?: string;
        limit?: number;
        mode?: 'snapshot' | 'reconstructed';
        suite?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 用例（含被排除的材料） */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            items: components['schemas']['EvalCase'][];
            next_cursor: string | null;
          };
        };
      };
    };
  };
  estimateEval: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          routes: string[];
          runs_per_case: number;
          suite: string;
        };
      };
    };
    responses: {
      /** @description 估算 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            calls: number;
            cases: number;
            cost: number;
            currency: string;
            input_tokens: number;
          };
        };
      };
    };
  };
  listEvalReports: {
    parameters: {
      query?: {
        limit?: number;
        mode?: 'snapshot' | 'reconstructed';
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 成绩单（新的在前） */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['eval-report.schema'][];
        };
      };
    };
  };
  getEvalReport: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        report_id: components['schemas']['Uuid'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 成绩单 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['eval-report.schema'];
        };
      };
      404: components['responses']['Error'];
    };
  };
  getEvalTrend: {
    parameters: {
      query?: {
        mode?: 'snapshot' | 'reconstructed';
        suite?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 按版本的成绩趋势 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            code_sha: string;
            created_at: components['schemas']['Timestamp'];
            gate_passed: boolean | null;
            rows: {
              model: string;
              route_id: string;
              top1: components['schemas']['Ratio'];
            }[];
            version: string;
          }[];
        };
      };
    };
  };
  listEvents: {
    parameters: {
      query?: {
        /** @description 游标，形如 server:<seq>,worker:<seq>；不填时从当前位置开始 */
        after?: string;
        limit?: number;
        types?: components['schemas']['EventType'][];
        wait?: number;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 事件批次 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            cursor: string;
            events: components['schemas']['events.schema'][];
          };
          'text/event-stream': string;
        };
      };
      400: components['responses']['Error'];
    };
  };
  getFreeze: {
    parameters: {
      query: {
        cluster_id: components['schemas']['ClusterId'];
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 熔断开关 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            cluster_id: components['schemas']['ClusterId'];
            configmap: string;
            frozen: boolean;
            instructions: {
              gitops_path: string;
              kubectl: string;
            };
            observed_at: components['schemas']['Timestamp'];
          };
        };
      };
    };
  };
  listIncidents: {
    parameters: {
      query?: {
        cluster_id?: components['schemas']['ClusterId'];
        component?: components['schemas']['ComponentKey'];
        cursor?: string;
        disposition?: components['schemas']['Disposition'];
        feedback?: 'pending' | 'given' | 'all';
        from?: string;
        limit?: number;
        /** @description 按标签、根因组件与告警名搜索 */
        q?: string;
        severity?: components['schemas']['Severity'];
        state?: 'firing' | 'resolved' | 'all';
        suppressed?: boolean;
        to?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 事件摘要 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            blind_spans: {
              cluster_id: components['schemas']['ClusterId'];
              from: components['schemas']['Timestamp'];
              /** @enum {string} */
              kind: 'ingest_silent' | 'observability_blind' | 'state_store_degraded';
              reason: string;
              /** @description 仍在持续时为 null */
              to: null | components['schemas']['Timestamp'];
            }[];
            items: components['schemas']['IncidentSummary'][];
            next_cursor: string | null;
            suppressed_count: number;
          };
        };
      };
      400: components['responses']['Error'];
      401: components['responses']['Error'];
    };
  };
  getIncident: {
    parameters: {
      query?: {
        /** @description 取指定版本；不填为最新版本 */
        version?: number;
      };
      header?: never;
      path: {
        /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
        incident_ref: components['parameters']['IncidentRef'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 事件全文 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['incident.schema'];
        };
      };
      401: components['responses']['Error'];
      404: components['responses']['Error'];
    };
  };
  getEvidenceSnapshot: {
    parameters: {
      query?: {
        run_id?: components['schemas']['Uuid'];
      };
      header?: never;
      path: {
        /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
        incident_ref: components['parameters']['IncidentRef'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 证据卡结果，按异常、无法判定、正常排序 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['evidence-result.schema'][];
        };
      };
      404: components['responses']['Error'];
    };
  };
  rerunEvidence: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path: {
        /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
        incident_ref: components['parameters']['IncidentRef'];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          refs: components['schemas']['EvidenceRef'][];
          /** @description 取这次研判声明的卡；为 null 时取最新阶段 A 报告的卡 */
          run_id: null | components['schemas']['Uuid'];
          /** @description 窗口终点，不得晚于当前时间；窗口长度沿用卡片定义 */
          window_to: components['schemas']['Timestamp'];
        };
      };
    };
    responses: {
      /** @description 重跑结果 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['evidence-result.schema'][];
        };
      };
      400: components['responses']['Error'];
      403: components['responses']['Error'];
      404: components['responses']['Error'];
      429: components['responses']['Error'];
    };
  };
  listFeedback: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
        incident_ref: components['parameters']['IncidentRef'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 反馈（新的在前） */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['feedback.schema'][];
        };
      };
    };
  };
  createFeedback: {
    parameters: {
      query?: never;
      header?: {
        /** @description 会话认证时必填；Bearer 认证时不需要 */
        'X-CSRF-Token'?: components['parameters']['CsrfOptional'];
        /** @description 只用于 Grafana 插件 token：Grafana 用户的邮箱 */
        'X-SreNautix-On-Behalf-Of'?: components['parameters']['OnBehalfOf'];
      };
      path: {
        /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
        incident_ref: components['parameters']['IncidentRef'];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['FeedbackCreate'];
      };
    };
    responses: {
      /** @description 已记录 */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['feedback.schema'];
        };
      };
      400: components['responses']['Error'];
      403: components['responses']['Error'];
    };
  };
  listResearchRuns: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
        incident_ref: components['parameters']['IncidentRef'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 该事件的全部研判（新的在前） */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ResearchRunSummary'][];
        };
      };
      404: components['responses']['Error'];
    };
  };
  requestResearch: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path: {
        /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
        incident_ref: components['parameters']['IncidentRef'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 已入队或与已有触发合并 */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @description 与同一 (incident_id */
            merged: boolean;
            run_id: components['schemas']['Uuid'];
          };
        };
      };
      404: components['responses']['Error'];
      429: components['responses']['Error'];
    };
  };
  getStageAReport: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
        incident_ref: components['parameters']['IncidentRef'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 阶段 A 报告 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['stage-a-report.schema'];
        };
      };
      404: components['responses']['Error'];
    };
  };
  recomputeStageA: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path: {
        /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
        incident_ref: components['parameters']['IncidentRef'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 新的阶段 A 报告 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['stage-a-report.schema'];
        };
      };
      404: components['responses']['Error'];
      409: components['responses']['Error'];
    };
  };
  getIncidentSubgraph: {
    parameters: {
      query?: {
        hops?: number;
        version?: number;
      };
      header?: never;
      path: {
        /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
        incident_ref: components['parameters']['IncidentRef'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 子图 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Subgraph'];
        };
      };
      404: components['responses']['Error'];
    };
  };
  getIncidentTimeline: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
        incident_ref: components['parameters']['IncidentRef'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 按时间排列 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['TimelineEntry'][];
        };
      };
      404: components['responses']['Error'];
    };
  };
  ingestAlerts: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        source_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          [key: string]: unknown;
        };
      };
    };
    responses: {
      /** @description 已接收 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['IngestResult'];
        };
      };
      /** @description 状态库降级，已在内存中处理 */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['IngestResult'];
        };
      };
      400: components['responses']['Error'];
      401: components['responses']['Error'];
      404: components['responses']['Error'];
    };
  };
  listIntegrations: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 集成实例 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['IntegrationInstance'][];
        };
      };
    };
  };
  testIntegration: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path: {
        instance_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 测试结果 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            ok: boolean;
            results: {
              capability: string;
              duration_ms: number;
              error: string | null;
              ok: boolean;
            }[];
          };
        };
      };
      404: components['responses']['Error'];
    };
  };
  listModelRoutes: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 模型路由、健康状况、故障域与出境类别 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ModelRouteStatus'][];
        };
      };
    };
  };
  listPacks: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 领域包与 pack.lock */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            pack_lock: components['schemas']['PackLock'];
            packs: components['schemas']['PackStatus'][];
          };
        };
      };
    };
  };
  getPause: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 软暂停状态 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PauseState'];
        };
      };
    };
  };
  setPause: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          expires_at: null | components['schemas']['Timestamp'];
          paused: boolean;
          reason: string | null;
        };
      };
    };
    responses: {
      /** @description 新的软暂停状态 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PauseState'];
        };
      };
    };
  };
  explainPermission: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          permission: components['schemas']['Permission'];
          subject: null | {
            groups: string[];
            id: string;
          };
          target: null | components['schemas']['PermissionTarget'];
          /** @enum {string|null} */
          tier: 'L' | 'H' | null;
        };
      };
    };
    responses: {
      /** @description 授权解释 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            allowed: boolean;
            entries: {
              binding: components['schemas']['RoleBinding'];
              file: string;
              grants_permission: boolean;
              reason: string;
              scope_match: boolean;
              subject_match: boolean;
              tier_ok: boolean;
            }[];
            permission: components['schemas']['Permission'];
            revision: string;
            subject: {
              groups: string[];
              id: string;
            };
            target: null | components['schemas']['PermissionTarget'];
            /** @enum {string|null} */
            tier: 'L' | 'H' | null;
          };
        };
      };
      403: components['responses']['Error'];
    };
  };
  getPolicies: {
    parameters: {
      query: {
        cluster_id: components['schemas']['ClusterId'];
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 从 Git 渲染出的生效策略、仓库 SHA 与漂移 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            drift: components['schemas']['Drift'];
            rendered: components['schemas']['gateway-policy.schema'];
            repo: string;
            sha: string;
          };
        };
      };
    };
  };
  simulatePolicy: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          action: string;
          cluster_id: components['schemas']['ClusterId'];
          params: {
            [key: string]: unknown;
          };
          target: {
            kind: string;
            name: string;
            namespace: string | null;
          };
        };
      };
    };
    responses: {
      /** @description 模拟结果 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            allowed: boolean;
            approvers: {
              role: string;
              subject: string;
            }[];
            auto: boolean;
            /** @enum {string|null} */
            level: 'reversible' | 'reversible_recreatable' | 'compensable' | 'irreversible' | null;
            reasons: string[];
            rules: string[];
            /** @enum {string|null} */
            tier: 'L' | 'H' | null;
          };
        };
      };
    };
  };
  listProposals: {
    parameters: {
      query?: {
        incident_id?: components['schemas']['Uuid'];
        limit?: number;
        state?: components['schemas']['State'];
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 提议（新的在前） */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['proposal.schema'][];
        };
      };
    };
  };
  createProposal: {
    parameters: {
      query?: never;
      header?: {
        /** @description 会话认证时必填；Bearer 认证时不需要 */
        'X-CSRF-Token'?: components['parameters']['CsrfOptional'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['ProposalCreate'];
      };
    };
    responses: {
      /** @description 幂等命中，返回已有提议 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['proposal.schema'];
        };
      };
      /** @description 已创建。策略拒绝时同样返回 201，state=rejected_by_policy */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['proposal.schema'];
        };
      };
      400: components['responses']['Error'];
      403: components['responses']['Error'];
      409: components['responses']['Error'];
      429: components['responses']['Error'];
    };
  };
  getProposal: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        proposal_id: components['parameters']['ProposalId'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 提议详情 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ProposalDetail'];
        };
      };
      404: components['responses']['Error'];
    };
  };
  approveProposal: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path: {
        proposal_id: components['parameters']['ProposalId'];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          /** @description H 档必须等于 target.display */
          confirm_target: string | null;
          /**
           * @description 合规配置下 H 档的通行密钥断言（navigator.credentials.get 的 PublicKeyCredential JSON），
           *     挑战来自 POST /v1/auth/webauthn/assertion-options；其余情况为 null
           */
          webauthn: null | {
            [key: string]: unknown;
          };
        };
      };
    };
    responses: {
      /** @description 已签发 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            envelope: components['schemas']['approval-envelope.schema'];
            proposal: components['schemas']['proposal.schema'];
          };
        };
      };
      403: components['responses']['Error'];
      404: components['responses']['Error'];
      409: components['responses']['Error'];
      422: components['responses']['Error'];
    };
  };
  rejectProposal: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path: {
        proposal_id: components['parameters']['ProposalId'];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          reason: string;
        };
      };
    };
    responses: {
      /** @description 已拒绝 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['proposal.schema'];
        };
      };
      404: components['responses']['Error'];
      409: components['responses']['Error'];
    };
  };
  undoProposal: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path: {
        proposal_id: components['parameters']['ProposalId'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 撤销已排队 */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['proposal.schema'];
        };
      };
      404: components['responses']['Error'];
      409: components['responses']['Error'];
    };
  };
  listRoleBindings: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 角色绑定 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @description RoleBinding 的全部字段，加上它所在的文件 */
            bindings: {
              file: string;
              /** @enum {string} */
              max_risk_tier?: 'L' | 'H';
              role: components['schemas']['role'];
              scope: components['schemas']['scope'];
              subject: components['schemas']['subject'];
            }[];
            revision: string;
          };
        };
      };
    };
  };
  getResearchRun: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        run_id: components['parameters']['RunId'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 研判全文 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ResearchRun'];
        };
      };
      404: components['responses']['Error'];
    };
  };
  promoteEvalCase: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path: {
        run_id: components['parameters']['RunId'];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          /** @enum {string} */
          case_type: 'incident' | 'benign' | 'abstain';
          suite: string;
        };
      };
    };
    responses: {
      /** @description 已创建用例 */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            case_id: string;
            /** @enum {string} */
            snapshot_status: 'queued' | 'frozen';
          };
        };
      };
      404: components['responses']['Error'];
      409: components['responses']['Error'];
    };
  };
  getResearchManifest: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        run_id: components['parameters']['RunId'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 研判清单与出境清单 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['research-manifest.schema'];
        };
      };
      404: components['responses']['Error'];
    };
  };
  getRawPrompts: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        run_id: components['parameters']['RunId'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 每次模型调用的原始提示词 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            messages: {
              content: string;
              /** @enum {string} */
              role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
            }[];
            phase: string;
            seq: number;
          }[];
        };
      };
      403: components['responses']['Error'];
      404: components['responses']['Error'];
    };
  };
  getRedactedPrompts: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        run_id: components['parameters']['RunId'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 每次模型调用的脱敏后提示词 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            messages: {
              content: string;
              /** @enum {string} */
              role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
            }[];
            phase: string;
            redaction_hits: number;
            seq: number;
          }[];
        };
      };
      404: components['responses']['Error'];
    };
  };
  search: {
    parameters: {
      query: {
        limit?: number;
        q: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 事件、组件、提议的匹配项 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            cluster_id: components['schemas']['ClusterId'];
            id: string;
            /** @enum {string} */
            kind: 'incident' | 'component' | 'proposal';
            title: string;
          }[];
        };
      };
    };
  };
  getSettings: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 设置 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Settings'];
        };
      };
    };
  };
  putSettings: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': components['schemas']['Settings'];
      };
    };
    responses: {
      /** @description 新的设置 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Settings'];
        };
      };
      400: components['responses']['Error'];
    };
  };
  getTopologyCoverage: {
    parameters: {
      query: {
        cluster_id: components['schemas']['ClusterId'];
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 覆盖表 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['TopologyCoverage'];
        };
      };
    };
  };
  getTopologyDiff: {
    parameters: {
      query: {
        cluster_id: components['schemas']['ClusterId'];
        /** @description 拓扑版本 */
        from: number;
        to: number;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 两个版本之间的差异 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            added_edges: components['schemas']['Edge'][];
            added_nodes: components['schemas']['Node'][];
            removed_edges: components['schemas']['Edge'][];
            removed_nodes: components['schemas']['Node'][];
          };
        };
      };
    };
  };
  getTopologyNeighborhood: {
    parameters: {
      query: {
        at?: string;
        cluster_id: components['schemas']['ClusterId'];
        component: components['schemas']['ComponentKey'];
        hops?: number;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 邻域图，每条边标注来源 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Subgraph'];
        };
      };
    };
  };
  createTopologyOverridePr: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          alertname: string;
          cluster_id: components['schemas']['ClusterId'];
          component: components['schemas']['ComponentKey'];
          /** @description 引出这条规则的事件；PR 与该事件的 issue 互相关联 */
          incident_id?: components['schemas']['Uuid'];
          role: components['schemas']['AlertRole'];
        };
      };
    };
    responses: {
      /** @description 已开 PR */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            branch: string;
            head_sha: string;
            /** @description 关联的事件 issue；没有给出 incident_id、没有开启事件 issue，或 issue 暂时没能开出时为 null */
            issue_url: string | null;
            pr_url: string;
          };
        };
      };
      404: components['responses']['Error'];
      409: components['responses']['Error'];
    };
  };
  listUsers: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 登录过的用户（最近登录在前） */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            chat_links: components['schemas']['ChatLink'][];
            display_name: string;
            first_login_at: components['schemas']['Timestamp'];
            groups: string[];
            last_login_at: components['schemas']['Timestamp'];
            principal_id: string;
            provider: string;
            roles: components['schemas']['RoleBinding'][];
          }[];
        };
      };
    };
  };
}
