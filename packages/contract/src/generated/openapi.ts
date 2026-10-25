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
  '/v1/alerts/lookup': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * @description 按一条告警的完整标签集找到它所属的事件（契约 2.32.0，ADR 0154）。Alertmanager 等外部通知只知道告警的标签，
     *     不知道事件 id，控制台的 `/alerts?l.<标签名>=<标签值>&…` 页面调用本接口后打开事件。
     *     中心按接入时同样的规则计算身份标签（去掉 alertgroup、alertstate、__name__ 与 ingest.external_labels）和指纹，
     *     取这个指纹开始时间最晚的一条告警，经事件成员关系与别名链找到所属事件；合并过的事件给出吸收它的事件，已恢复的事件照常给出。
     *     找不到时 outcome 说明原因。只读
     */
    get: operations['lookupAlert'];
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
  '/v1/findings': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description 发现（ADR 0146 §1.4），按 last_seen 从新到旧 */
    get: operations['listFindings'];
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
  '/v1/goals': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description 主动优化的目标（ADR 0146 §5.1），按 created_at 从新到旧 */
    get: operations['listGoals'];
    put?: never;
    /**
     * @description 下达目标。指标与参数按领域包的指标目录校验，模型与调用方都不能提交自由查询；作用域按范围内组件所在的命名空间检查。
     *     每个主体每天最多 5 个目标、每个集群同时最多 10 个未结束的目标，超过时返回 429
     */
    post: operations['createGoal'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/goals/{goal_id}': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        goal_id: components['parameters']['GoalId'];
      };
      cookie?: never;
    };
    get: operations['getGoal'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/goals/{goal_id}/cancel': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        goal_id: components['parameters']['GoalId'];
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description 取消未结束的目标；进行中的运行在下一个检查点停止，已创建的 PR 与 issue 不受影响 */
    post: operations['cancelGoal'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/goals/{goal_id}/runs': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        goal_id: components['parameters']['GoalId'];
      };
      cookie?: never;
    };
    get: operations['listGoalRuns'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/goals/{goal_id}/runs/{run_id}': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        goal_id: components['parameters']['GoalId'];
        run_id: components['parameters']['RunId'];
      };
      cookie?: never;
    };
    /** @description 运行明细：基线、候选发现、账本、结论、建议与门槛记录。模型调用与出境清单见 /v1/runs/{run_id}/manifest */
    get: operations['getGoalRun'];
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
  '/v1/optimization/catalog': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description 加载的领域包声明的指标与领域（新建目标时选择），以及每个指标的参数 schema 与参数取值的候选 */
    get: operations['getOptimizationCatalog'];
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
  '/v1/recommendations': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description 主动优化的建议与验证结果，按 created_at 从新到旧 */
    get: operations['listRecommendations'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/recommendations/{recommendation_id}/reject': {
    parameters: {
      query?: never;
      header?: never;
      path: {
        recommendation_id: components['parameters']['RecommendationId'];
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description 控制台或聊天里点了“建议无用”：发现记为 rejected 并进入冷却期（ADR 0146 §4.5）；已创建的 PR 与 issue 不受影响 */
    post: operations['rejectRecommendation'];
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
     * @description 为未映射的告警计划拓扑覆盖规则的 PR，提交为 gitops_pr 提议（ADR 0025、0108）：server 只读地取 base 分支上的覆盖文件、
     *     生成补丁；PR 由 gateway 在提议批准后经 gitops_pr 开出（只推送到 srenautix/* 分支，从不合并）。
     *     提议绑定事件：给出 incident_id 时用它，否则取包含这条告警的最近一个事件，没有时 409（error no_incident）。
     *     发起人能审批时（控制台会话、L 档、不是合规配置下的自批）直接批准，否则留待审批。
     *     同一条规则重复发起时返回已有的提议（200）。开启了事件 issue 时 PR 描述写 `Refs #<issue>`，PR 开出后 issue 里回链
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
    /** @description 按标签集查找告警所属事件的结果（契约 2.32.0，ADR 0154） */
    AlertLookup: {
      /** @description 这个指纹开始时间最晚的一条告警；outcome 为 incident 或 not_grouped 时有值 */
      alert: null | {
        alert_id: string;
        cluster_id: components['schemas']['ClusterId'];
        ends_at: null | components['schemas']['Timestamp'];
        received_at: components['schemas']['Timestamp'];
        starts_at: components['schemas']['Timestamp'];
        /** @enum {string} */
        status: 'firing' | 'resolved';
      };
      /** @description 收到的标签中不计入身份的标签名（alertgroup、alertstate、__name__ 与 external labels），按名称排序 */
      excluded_labels: string[];
      /** @description 按身份标签计算的告警指纹（与 alert_state.fingerprint 相同） */
      fingerprint: string;
      identity_labels: components['schemas']['Labels'];
      /** @description 所属事件；合并过的事件为吸收它的事件。outcome 为 incident 时有值 */
      incident: null | {
        incident_id: components['schemas']['Uuid'];
        label: string;
        /** @enum {string} */
        state: 'firing' | 'resolved';
      };
      /**
       * @description incident：找到所属事件（incident 不为空）；
       *     not_received：中心没有收到过这个身份标签集的告警；
       *     not_grouped：收到了告警（alert 不为空），事件引擎还没有把它归入任何事件；
       *     not_visible：告警或它所属的事件不在调用方的读取范围内，alert 与 incident 都为空；
       *     self_alert：标签里有 ingest.self_label，是 SreNautix 自身的元告警，接入时丢弃；
       *     ignored：Watchdog（ingest.watchdog_alertname）、InfoInhibitor 或 severity=none，接入时丢弃，不进入事件
       * @enum {string}
       */
      outcome: 'incident' | 'not_received' | 'not_grouped' | 'not_visible' | 'self_alert' | 'ignored';
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
    /** OptimizationBaseline */
    Baseline: {
      indicators: components['schemas']['BaselineIndicator'][];
      /** @description 基线不足时缺少的数据（例如“postgres/db-time 覆盖率 72%”） */
      missing: string[];
      /** @description 覆盖率不低于 90% 且至少 3 个业务高峰；否则运行以 failed（baseline_insufficient）结束 */
      sufficient: boolean;
      window: components['schemas']['TimeWindow'];
    };
    /** BaselineIndicator */
    BaselineIndicator: {
      /** @enum {string} */
      better: 'lower' | 'higher';
      covered_hours: number;
      entity: components['schemas']['EntityKey'];
      /** @description 按小时的取值 [unix 秒, 值或 null]，控制台画基线图 */
      hourly: [number, number | null][];
      hours: number;
      indicator: components['schemas']['IndicatorRef'];
      params: {
        [key: string]: number | string | boolean;
      };
      /** @description 按负载指标判定的业务高峰小时数（负载前 20%） */
      peak_hours: number;
      statistic: components['schemas']['IndicatorStatistic'];
      unit: components['schemas']['IndicatorUnit'];
      /** @description 统计值；没有数据时为 null */
      value: number | null;
      /** @description 违反目标或门槛的小时占比；没有目标与门槛时为 null */
      violation_ratio: number | null;
    };
    /**
     * ProposalBinding
     * @description 主体为事件时是事件版本、根因组件与阶段 A 的证据指纹；主体为目标时（契约 2.28.0）incident_version 取目标的 revision，root_component 取发现挂到的组件，evidence_fingerprint 取发现的证据指纹。审批断言 v1 与 gateway 的绑定核对不变
     */
    Binding: {
      evidence_fingerprint: components['schemas']['Sha256'];
      incident_version: number;
      root_component: components['schemas']['ComponentKey'];
    };
    /** OptimizationCandidate */
    Candidate: {
      card_ref: components['schemas']['EvidenceRef'];
      component: components['schemas']['ComponentKey'];
      /** @description <领域>/<诊断卡 id> */
      diagnostic: string;
      entity: components['schemas']['FindingEntity'];
      /** @description 发现指纹 */
      finding: components['schemas']['Sha256'];
      gap: number | null;
      kind: string;
      score: number;
      selected: boolean;
      share: number | null;
      share_ref: null | components['schemas']['EvidenceRef'];
      /**
       * @description 没有进入假设的原因：rank（排在前 3 之外）、verifying（已修复的发现在验证期内）、cooldown
       * @enum {string|null}
       */
      skipped_reason: 'rank' | 'verifying' | 'cooldown' | null;
    };
    /** ChangeEvent */
    ChangeEvent: {
      actor: string | null;
      /** @description 推导出的变更挂上的前置对象及推导依据（ADR 0104 §13），例如发布之前的迁移 Job。basis：managed_by（与发布由同一个应用管理：managed_by 边或 Argo 的 instance 标签）、revision_label（配置的版本标签取值与发布的相同，例如 cchp.io/release-id）、image（Pod 镜像与发布新 ReplicaSet 的镜像相同）、namespace_window（只按同一命名空间与时间窗推断，是弱推导） */
      attachments?: {
        /** @enum {string} */
        basis: 'managed_by' | 'revision_label' | 'image' | 'namespace_window';
        target: components['schemas']['ComponentKey'];
      }[];
      /** @description <source>:<来源内唯一标识>，用于去重 */
      change_id: string;
      /**
       * @description rollout：新 ReplicaSet/ControllerRevision；config：挂载的 ConfigMap 版本变化；cordon；scale：HPA 或手动扩缩；gitops_sync：Argo/Flux 同步；ci_deploy：CI 部署；operator：Operator 发起的切换或升级；runtime_config：经管理接口或数据库直接生效的运行时配置变更，不经过 Git 与发布（契约 2.29.0，SQL 审计表变更源读到的记录）；other
       * @enum {string}
       */
      kind:
        | 'rollout'
        | 'config'
        | 'cordon'
        | 'scale'
        | 'gitops_sync'
        | 'ci_deploy'
        | 'operator'
        | 'runtime_config'
        | 'other';
      link: string | null;
      /** @description 变更之前的版本（版本标签的旧取值）；与更早一次变更的 revision 相同时，这次变更是回退。来源不知道旧版本时省略或为 null */
      previous_revision?: string | null;
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
     * Comparator
     * @enum {string}
     */
    Comparator: 'lt' | 'le' | 'gt' | 'ge';
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
      consistency_detail?: components['schemas']['ConsistencyDetail'];
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
    /** EvidenceCondition */
    Condition: {
      /** @description 条件的 CEL 表达式 */
      cel: string;
      /** @enum {string} */
      kind: 'undeterminable' | 'abnormal';
      /**
       * @description hit：命中；miss：求值为 false；unavailable：依赖的引用或绑定没有数据，没有求值
       * @enum {string}
       */
      outcome: 'hit' | 'miss' | 'unavailable';
      /** @description 命中时为条件的 say；没有命中时为条件的 normal_say（卡片提供时），否则为 null */
      say: string | null;
    };
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
     * ConsistencyDetail
     * @description 四个条件各自的依据，由结论阶梯的代码给出：支持卡、支持的成员告警、最早的异常起点、症状起点与容差、相反的正常卡、检验过与同样得到支持的竞争假设、结论由谁选中
     */
    ConsistencyDetail: {
      /**
       * @description model：模型在 conclude 中选中；ledger：模型弃权，由代码按账本选中（ADR 0120，档位最高为 likely）
       * @enum {string}
       */
      chosen_by: 'model' | 'ledger';
      contrary_refs: components['schemas']['EvidenceRef'][];
      /** @description 由小模型判定的支持卡（只能支持 likely） */
      model_judged_refs: components['schemas']['EvidenceRef'][];
      /** @description 支持卡中最早的异常起点；没有可确定起点的支持卡时为 null */
      onset: null | {
        at: components['schemas']['Timestamp'];
        ref: components['schemas']['EvidenceRef'];
      };
      /** @description 计入支持的成员告警（ADR 0122）；只有它们支持时档位最高为 likely */
      support_alerts: components['schemas']['EvidenceRef'][];
      /** @description 由领域包规则判定、实体在假设范围内的异常卡 */
      support_refs: components['schemas']['EvidenceRef'][];
      /** @description 同样处于支持状态的竞争假设（ADR 0124）；不为空时第 4 个条件不满足 */
      supported_competitors: string[];
      /** @description 症状起点：最早触发的 symptom 角色成员告警，没有时为事件首次触发时间 */
      symptom_onset_at: components['schemas']['Timestamp'];
      /** @description 执行过检查或已被推翻的竞争假设 */
      tested_competitors: string[];
      tolerance_seconds: number;
    };
    /** RecommendationDelivery */
    Delivery: {
      /** @description ops_pr 的分支 srenautix/goal-… */
      branch: string | null;
      /** @description issue 的关闭原因或 PR 未合并就关闭（unmerged）；未关闭时为 null */
      closed_reason: null | ('completed' | 'not_planned' | 'unmerged');
      merge_commit: string | null;
      merged_at: null | components['schemas']['Timestamp'];
      /** @description PR 或 issue 号；PR 还没有创建时为 null */
      number: number | null;
      /** @description ops_pr 的 gitops_pr 提议；business_issue 为 null */
      proposal_id: null | components['schemas']['Uuid'];
      repository: string;
      /**
       * @description ops：ops 仓库（只经 gateway 的 gitops_pr）；business：业务仓库（只创建 issue 与评论）
       * @enum {string}
       */
      repository_role: 'ops' | 'business';
      url: string | null;
    };
    /**
     * Disposition
     * @description 处置判断：act 处理；ignore 忽略；escalate 升级；undetermined 无法判定
     * @enum {string}
     */
    Disposition: 'act' | 'ignore' | 'escalate' | 'undetermined';
    /** DomainId */
    DomainId: string;
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
    /**
     * EgressCategory
     * @description 出境数据类别。sql：规范化语句文本（常量为 $n、去掉注释）；code：业务代码片段（契约 2.28.0，ADR 0146 §3.6）
     * @enum {string}
     */
    EgressCategory:
      'metrics' | 'logs' | 'traces' | 'events' | 'topology' | 'changes' | 'alerts' | 'knowledge' | 'sql' | 'code';
    /** EgressEntry */
    EgressEntry: {
      bytes: number;
      categories: components['schemas']['EgressCategory'][];
      /** @description 不在 llm.egress.categories 中、进入提示词之前删除的片段数，按类别计（契约 2.28.0，ADR 0146 §3.6）；没有删除时不填或为空对象 */
      dropped?: {
        [key: string]: number;
      };
      in_domain: boolean;
      redaction_hits: number;
      route_id: string;
    };
    /**
     * EntityKey
     * @description 主动优化的实体键（契约 2.28.0，ADR 0146 §1.1）：Kubernetes 对象或领域包组件为 ComponentKey；逻辑实体为 <类型>:<组件内的键>，例如 pg_statement:<CNPG Cluster 名>/<库>/<语句指纹>、pg_table:<Cluster 名>/<库>/<schema>.<表>、route:<服务>/<endpoint>、stage:<服务>/<阶段>。逻辑实体都挂到一个拓扑组件上
     */
    EntityKey: string;
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
     * EstimateValue
     * @description 模板 estimate 的求值结果：lower 为保守下界，expected 为期望值，单位与指标相同，按改善方向取正值
     */
    EstimateValue: {
      basis: string;
      expected: number | null;
      indicator: components['schemas']['IndicatorRef'];
      lower: number;
      unit: components['schemas']['IndicatorUnit'];
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
          | 'condition.changed'
          | 'goal.created'
          | 'goal.run.concluded'
          | 'finding.updated'
          | 'recommendation.updated'
          | 'outcome.verified';
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
          | 'resumed'
          | 'reopened';
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
        /**
         * GoalCreatedEvent
         * @description 目标创建（契约 2.28.0）
         */
        GoalCreated: {
          payload: components['schemas']['goal.schema'];
          /** @constant */
          type: 'goal.created';
        } & components['schemas']['Header'];
        /**
         * GoalRunConcludedEvent
         * @description 目标运行结束（契约 2.28.0），含失败与没有差距
         */
        GoalRunConcluded: {
          payload: {
            goal_id: components['schemas']['Uuid'];
            goal_revision: number;
            /** @description 运行输出；在基线之前失败时为 null */
            output: null | components['schemas']['optimization-output.schema'];
            run_id: components['schemas']['Uuid'];
            summary: components['schemas']['GoalRunSummary'];
          };
          /** @constant */
          type: 'goal.run.concluded';
        } & components['schemas']['Header'];
        /**
         * FindingUpdatedEvent
         * @description 发现创建或更新（契约 2.28.0）
         */
        FindingUpdated: {
          payload: components['schemas']['finding.schema'];
          /** @constant */
          type: 'finding.updated';
        } & components['schemas']['Header'];
        /**
         * RecommendationUpdatedEvent
         * @description 建议创建或状态变化（契约 2.28.0）
         */
        RecommendationUpdated: {
          payload: components['schemas']['recommendation.schema'];
          /** @constant */
          type: 'recommendation.updated';
        } & components['schemas']['Header'];
        /**
         * OutcomeVerifiedEvent
         * @description 建议的验证结束（契约 2.28.0）
         */
        OutcomeVerified: {
          payload: {
            finding: components['schemas']['Sha256'];
            goal_id: components['schemas']['Uuid'];
            outcome: components['schemas']['RecommendationOutcome'];
            recommendation_id: components['schemas']['Uuid'];
          };
          /** @constant */
          type: 'outcome.verified';
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
      | components['schemas']['GoalCreated']
      | components['schemas']['GoalRunConcluded']
      | components['schemas']['FindingUpdated']
      | components['schemas']['RecommendationUpdated']
      | components['schemas']['OutcomeVerified']
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
      | 'condition.changed'
      | 'goal.created'
      | 'goal.run.concluded'
      | 'finding.updated'
      | 'recommendation.updated'
      | 'outcome.verified';
    /**
     * EvidenceResult
     * @description 一张证据卡在一次研判（或阶段 A 报告）中的结果（DESIGN §6.1）。三种结论之外另有显示状态 capability_missing：所需的数据源能力不可用，和没有数据区分开
     */
    'evidence-result.schema': {
      /** @description 异常的起始时间，用于 evidence_consistent 判定中的时间条件；无法确定时为 null */
      anomaly_started_at?: null | components['schemas']['Timestamp'];
      /** @description 对比基线（卡片 display.baseline 的取值）；卡片没有基线或基线不可用时为 null */
      baseline?: number | null;
      /** @description <pack>/<chain>/<card>；区分性检查产生的卡为 check/<hypothesis id>/<n> */
      card_id: string;
      /**
       * @description 卡片定义的业务关键信号类别（EvidenceCardDefinition.category）；没有时为 null，通知按证据链名推断（ADR 0148）
       * @enum {string|null}
       */
      category?: 'storage' | 'memory' | 'cpu' | 'traffic' | 'blocking' | null;
      /** @description 求值过的判定条件，按求值顺序：undeterminable_if 全部条件，abnormal_if 到第一条命中为止 */
      conditions?: components['schemas']['Condition'][];
      /**
       * @description verdict 为 undeterminable 且原因是所需能力不可用时为 capability_missing，其余与 verdict 相同
       * @enum {string}
       */
      display_state: 'normal' | 'abnormal' | 'undeterminable' | 'capability_missing';
      egress: components['schemas']['Egress'];
      entity: null | components['schemas']['EntityRef'];
      evaluated_at: components['schemas']['Timestamp'];
      /** @description 卡片标为影响类（impact: true），异常时它的值进入通知的影响范围 */
      impact?: boolean;
      /** @description 证据基线（契约 2.31.0，ADR 0153）：判为异常的卡在同一实体上、按同样长度的窗口在事件之前的时段重新判定，与事件窗口比较。常态（routine）的卡不能作为根因或支持证据。只对异常卡计算；正常与无法判定的卡、关闭了证据基线的部署为 null 或不出现 */
      novelty?: null | components['schemas']['Novelty'];
      /** @description 判定时 let 绑定的标量取值（数值、字符串、布尔），按定义顺序最多 16 个；绑定不可用时为 null。通知与控制台用它展示正常卡的实测值 */
      observations?: {
        [key: string]: number | string | boolean | null;
      };
      /** @description 本次判定生效的 params（卡片默认值与覆盖值合并后），即判定条件里的阈值 */
      params?: {
        [key: string]: number | string | boolean;
      };
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
      /**
       * @description 主值、阈值与基线的单位（卡片 display.unit）；没有时为 none
       * @enum {string}
       */
      unit?: 'none' | 'percent' | 'ratio' | 'bytes' | 'seconds' | 'count' | 'per_second';
      /** @description 主值的展示文本 */
      value: string | null;
      /** @description 主值（display.value）格式化之前的数值，与 threshold 同单位；没有主值或不是有限数时为 null。通知用它判断正常卡是否接近阈值 */
      value_number?: number | null;
      verdict: components['schemas']['Verdict'];
      window: components['schemas']['TimeWindow'];
      $defs: {
        /** EvidenceNovelty */
        Novelty: {
          /** @description 得出结论的基线样本中判为异常的比例；没有样本时为 null */
          abnormal_share: number | null;
          /** @description 固定的对照时段（默认事件前 1 小时、24 小时、7 天的同一时段）上的判定与主值 */
          comparisons: components['schemas']['NoveltyComparison'][];
          /** @description 基线样本主值的分位区间 [1 − quantile, quantile]；有主值的样本不足时为 null */
          range: null | {
            high: number;
            low: number;
            quantile: number;
          };
          /** @description 判定说明 */
          reason: string;
          /** @description 判为常态所依据的规则：abnormal_share 基线样本中判为异常的比例不低于门槛；within_range 主值落在基线样本主值的分位区间内；below_ratio 计数或速率类主值与对照时段的最大值相差不到门槛倍数。不是常态时为 null */
          rule: null | ('abnormal_share' | 'within_range' | 'below_ratio');
          /** @description 得出结论（正常或异常）的基线样本数，含对照时段 */
          samples: number;
          /**
           * @description novel：与基线相比明显异常；routine：常态，与基线相比没有明显升高；unknown：得出结论的基线样本不足（更早的时段没有数据、超出保留期，或在期限内没有完成）
           * @enum {string}
           */
          status: 'novel' | 'routine' | 'unknown';
          /** @description 事件窗口内的主值（value_number） */
          value: number | null;
        };
        /**
         * EvidenceNoveltyComparison
         * @description 一个对照时段：offset 为它相对事件窗口提前的时长
         */
        NoveltyComparison: {
          offset: components['schemas']['Duration'];
          /** @description 对照时段的主值；没有主值时为 null */
          value: number | null;
          verdict: components['schemas']['Verdict'];
          window: components['schemas']['TimeWindow'];
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
        /** EvidenceCondition */
        Condition: {
          /** @description 条件的 CEL 表达式 */
          cel: string;
          /** @enum {string} */
          kind: 'undeterminable' | 'abnormal';
          /**
           * @description hit：命中；miss：求值为 false；unavailable：依赖的引用或绑定没有数据，没有求值
           * @enum {string}
           */
          outcome: 'hit' | 'miss' | 'unavailable';
          /** @description 命中时为条件的 say；没有命中时为条件的 normal_say（卡片提供时），否则为 null */
          say: string | null;
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
    /**
     * Finding
     * @description 一个实体上的一个问题（契约 2.28.0，ADR 0146 §1.4），跨分析运行持久保存；fingerprint 是去重的唯一键。每次运行先按指纹更新已有发现（last_seen、差距、份额、档位），再判断是否生成建议
     */
    'finding.schema': {
      cluster_id: components['schemas']['ClusterId'];
      /** @description 实体挂到的拓扑组件（逻辑实体）或实体本身（Kubernetes 对象） */
      component: components['schemas']['ComponentKey'];
      /** @description 被拒绝之后的冷却期限 */
      cooldown_until: null | components['schemas']['Timestamp'];
      domain: components['schemas']['DomainId'];
      entity: components['schemas']['FindingEntity'];
      /** @description 支持卡与份额卡的判定向量指纹；未分析时为 null */
      evidence_fingerprint: null | components['schemas']['Sha256'];
      /** @description sha256(JCS([cluster_id, domain, kind, entity.key])) */
      fingerprint: components['schemas']['Sha256'];
      first_seen: components['schemas']['Timestamp'];
      /** @description 指标相对目标或门槛的差距（指标单位，按改善方向取正值）；没有可比较的目标时为 null */
      gap: number | null;
      /** @description 发现影响的指标；诊断卡没有声明时为 null */
      indicator: null | components['schemas']['IndicatorRef'];
      /** @description 领域声明的发现类型（DomainDiagnostic.finding），例如 pg.statement_dominant、pg.temp_spill、workload.cpu_overprovisioned */
      kind: string;
      last_goal_id: null | components['schemas']['Uuid'];
      last_run_id: null | components['schemas']['Uuid'];
      last_seen: components['schemas']['Timestamp'];
      /** @description 最近一次分析的结论档位（ADR 0146 §2.4）；进入候选但未分析时为 null */
      level: null | components['schemas']['ConclusionLevel'];
      /** @description 实体在指标中的份额（份额卡）；没有份额卡时为 null */
      share: number | null;
      status: components['schemas']['FindingStatus'];
      updated_at: components['schemas']['Timestamp'];
      $defs: {
        /**
         * FindingStatus
         * @description open 已发现；recommended 已有建议（PR 或 issue）；accepted PR 合并或 issue 以 completed 关闭；verifying 验证中；fixed 验证改善或差距消失（待人确认关闭）；no_effect 验证没有效果；regressed 验证回退；rejected 被拒绝，进入冷却期；suppressed 人工抑制
         * @enum {string}
         */
        FindingStatus:
          | 'open'
          | 'recommended'
          | 'accepted'
          | 'verifying'
          | 'fixed'
          | 'no_effect'
          | 'regressed'
          | 'rejected'
          | 'suppressed';
        /** FindingEntity */
        FindingEntity: {
          /** @description 可读名称，只用于显示 */
          display: string;
          key: components['schemas']['EntityKey'];
          /** @description 实体的标签（EntityRows.labels），例如 pg_statement 的 database、queryid；按实体执行的卡片与模板以 $params 引用 */
          labels: components['schemas']['Labels'];
          /** @description 逻辑实体类型（pg_statement、pg_table、pg_index、route、stage），或 Kubernetes 的 Kind */
          type: string;
        };
      };
    };
    /** FindingConclusion */
    FindingConclusion: {
      /** @enum {string} */
      chosen_by: 'model' | 'ledger';
      consistency: components['schemas']['OptimizationConsistency'];
      contrary_refs: components['schemas']['EvidenceRef'][];
      finding: components['schemas']['Sha256'];
      hypothesis_id: string | null;
      level: components['schemas']['ConclusionLevel'];
      /** @description 【模型】选择这个假设的说明 */
      note: string | null;
      share_refs: components['schemas']['EvidenceRef'][];
      support_refs: components['schemas']['EvidenceRef'][];
      undetermined_reason: string | null;
    };
    /** FindingEntity */
    FindingEntity: {
      /** @description 可读名称，只用于显示 */
      display: string;
      key: components['schemas']['EntityKey'];
      /** @description 实体的标签（EntityRows.labels），例如 pg_statement 的 database、queryid；按实体执行的卡片与模板以 $params 引用 */
      labels: components['schemas']['Labels'];
      /** @description 逻辑实体类型（pg_statement、pg_table、pg_index、route、stage），或 Kubernetes 的 Kind */
      type: string;
    };
    /** FindingHypothesis */
    FindingHypothesis: {
      finding: components['schemas']['Sha256'];
      hypothesis: components['schemas']['Hypothesis'];
    };
    /**
     * FindingStatus
     * @description open 已发现；recommended 已有建议（PR 或 issue）；accepted PR 合并或 issue 以 completed 关闭；verifying 验证中；fixed 验证改善或差距消失（待人确认关闭）；no_effect 验证没有效果；regressed 验证回退；rejected 被拒绝，进入冷却期；suppressed 人工抑制
     * @enum {string}
     */
    FindingStatus:
      | 'open'
      | 'recommended'
      | 'accepted'
      | 'verifying'
      | 'fixed'
      | 'no_effect'
      | 'regressed'
      | 'rejected'
      | 'suppressed';
    /**
     * FindingUpdatedEvent
     * @description 发现创建或更新（契约 2.28.0）
     */
    FindingUpdated: {
      payload: components['schemas']['finding.schema'];
      /** @constant */
      type: 'finding.updated';
    } & components['schemas']['Header'];
    /** OptimizationGap */
    Gap: {
      /**
       * @description objective 按目标值；gate 按领域门槛；none 基线不足或没有可比较的目标
       * @enum {string}
       */
      basis: 'objective' | 'gate' | 'none';
      detail: string;
      exists: boolean;
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
    /** GateRecord */
    GateRecord: {
      /** @description 机器可读的原因码，与 remediation_attempts 的方式相同；G3 不通过时为模板 guard 的 id */
      code: string;
      detail: string;
      /**
       * @description G1 证据档位；G2 预期收益；G3 安全约束；G4 新颖性；G5 数量；G6 时机
       * @enum {string}
       */
      gate: 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6';
      passed: boolean;
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
    /**
     * Goal
     * @description 主动优化的目标（契约 2.28.0，ADR 0146 §1.2）。目标只引用领域包声明的指标或领域，不含任何自由查询；规格每修改一次 revision 加一。每次分析是一次目标运行（GoalRunSummary），结果见 optimization-output.schema.json
     */
    'goal.schema': {
      cluster_id: components['schemas']['ClusterId'];
      created_at: components['schemas']['Timestamp'];
      /** @description 到期仍未达成时状态为 expired，附最后一次分析的报告 */
      expires_at: components['schemas']['Timestamp'];
      goal_id: components['schemas']['Uuid'];
      /** @description 最近一次运行；还没有运行时为 null */
      last_run: null | components['schemas']['GoalRunSummary'];
      revision: number;
      spec: components['schemas']['GoalSpec'];
      state: components['schemas']['GoalState'];
      /** @description 状态的机器可读原因，例如 failed 的 baseline_insufficient、cancelled 的 user */
      state_reason: string | null;
      updated_at: components['schemas']['Timestamp'];
      $defs: {
        /**
         * GoalState
         * @description queued 排队；analyzing 分析中；recommended 有建议已发布；verifying 验证中；achieved 达成；not_achieved 验证后未达成；no_action 没有差距或没有通过门槛的建议；cancelled 取消；expired 到期；failed 失败（state_reason 写明原因）
         * @enum {string}
         */
        GoalState:
          | 'queued'
          | 'analyzing'
          | 'recommended'
          | 'verifying'
          | 'achieved'
          | 'not_achieved'
          | 'no_action'
          | 'cancelled'
          | 'expired'
          | 'failed';
        /** GoalSpec */
        GoalSpec: {
          budget: components['schemas']['GoalBudget'];
          /** @description 目标值；领域体检没有目标值时为 null，差距按领域的门槛（DomainGates.thresholds） */
          objective: null | components['schemas']['GoalObjective'];
          origin: components['schemas']['GoalOrigin'];
          /** @description 允许的建议类别 */
          outputs: components['schemas']['RecommendationKind'][];
          subject: components['schemas']['GoalSubject'];
        };
        /**
         * RecommendationKind
         * @description ops_pr：ops 仓库的 PR（gitops_pr 提议）；business_issue：业务仓库的 issue
         * @enum {string}
         */
        RecommendationKind: 'ops_pr' | 'business_issue';
        /**
         * GoalOrigin
         * @description 目标的来源：manual 人工下达；checkup 领域的定期体检；trend 趋势扫描；forecast_alert 预测类告警
         */
        GoalOrigin:
          | {
              /** @enum {string} */
              channel: 'console' | 'telegram' | 'api';
              /** @constant */
              kind: 'manual';
              /** @description 下达目标的主体 id；api 为调用方 id */
              principal: string;
            }
          | {
              domain: components['schemas']['DomainId'];
              /** @constant */
              kind: 'checkup';
              schedule_id: string;
            }
          | {
              entity: components['schemas']['EntityKey'];
              /** @constant */
              kind: 'trend';
              /** @description <包>/<领域>/<趋势 id> */
              trend: string;
            }
          | {
              alert_fingerprint: string;
              /** @constant */
              kind: 'forecast_alert';
            };
        /** DomainId */
        DomainId: string;
        /**
         * GoalScope
         * @description 范围白名单：组件键与命名空间；两者都为空表示不限
         */
        GoalScope: {
          components: components['schemas']['ComponentKey'][];
          namespaces: string[];
        };
        /**
         * GoalSubject
         * @description 目标对象：一个指标（带参数），或一个领域的体检
         */
        GoalSubject:
          | {
              indicator: components['schemas']['IndicatorRef'];
              /** @description 按指标的 params schema 校验 */
              params: {
                [key: string]: number | string | boolean;
              };
              scope: components['schemas']['GoalScope'];
              /** @constant */
              type: 'indicator';
            }
          | {
              domain: components['schemas']['DomainId'];
              scope: components['schemas']['GoalScope'];
              /** @constant */
              type: 'domain';
            };
        /**
         * Comparator
         * @enum {string}
         */
        Comparator: 'lt' | 'le' | 'gt' | 'ge';
        /** GoalObjective */
        GoalObjective: {
          comparator: components['schemas']['Comparator'];
          statistic: components['schemas']['IndicatorStatistic'];
          target: number;
          unit: components['schemas']['IndicatorUnit'];
          /** @description 基线窗口，默认 7d，不超过 14d */
          window: components['schemas']['Duration'];
        };
        /**
         * GoalBudget
         * @description 一次运行的预算（ADR 0146 §1.2 的默认值）
         */
        GoalBudget: {
          /** @default 12 */
          checks: number;
          /** @default 8388608 */
          code_bytes: number;
          /** @default 200 */
          code_files: number;
          /** @default 30 */
          dbstats_queries: number;
          /** @default 1200 */
          duration_seconds: number;
          /** @default 300 */
          github_requests: number;
          /** @default 10 */
          logs_queries: number;
          /** @default 400000 */
          tokens: number;
          /** @default 10 */
          traces_queries: number;
        };
        /**
         * GoalCreate
         * @description 下达目标的请求体（POST /v1/goals）。origin 由认证上下文决定（控制台会话为 console，API token 为 api，聊天渠道的确认卡片为 telegram）；budget 只写要改的项，其余取默认值
         */
        GoalCreate: {
          budget?: {
            checks?: number;
            code_bytes?: number;
            code_files?: number;
            dbstats_queries?: number;
            duration_seconds?: number;
            github_requests?: number;
            logs_queries?: number;
            tokens?: number;
            traces_queries?: number;
          };
          cluster_id: components['schemas']['ClusterId'];
          /** @description 有效期，默认 14d，不超过 30d */
          expires_in?: components['schemas']['Duration'];
          objective: null | components['schemas']['GoalObjective'];
          outputs: components['schemas']['RecommendationKind'][];
          subject: components['schemas']['GoalSubject'];
        };
        /**
         * GoalRunState
         * @description queued 排队；deferred 被准入推迟（defer_reason）；running 执行中；concluded 结束（result）；failed 失败；cancelled 目标取消
         * @enum {string}
         */
        GoalRunState: 'queued' | 'deferred' | 'running' | 'concluded' | 'failed' | 'cancelled';
        /** GoalRunSummary */
        GoalRunSummary: {
          /** @description 本次运行发现或更新的发现数 */
          findings: number;
          finished_at: null | components['schemas']['Timestamp'];
          /** @description 差距是否成立；基线之前为 null */
          gap: boolean | null;
          goal_id: components['schemas']['Uuid'];
          goal_revision: number;
          queued_at: components['schemas']['Timestamp'];
          /** @description deferred 的原因（budget、storm、incident、load_guard、rate_limit、schedule_window）或 failed 的原因（baseline_insufficient、model_unavailable、budget_exhausted、deadline、datasource、internal） */
          reason: string | null;
          /** @description 通过全部门槛的建议数 */
          recommendations: number;
          /** @description concluded 时的结果：no_gap 没有差距（不调用模型）；recommended 有通过门槛的建议；report_only 有发现、没有建议通过门槛；其余状态为 null */
          result: null | ('no_gap' | 'recommended' | 'report_only');
          run_id: components['schemas']['Uuid'];
          started_at: null | components['schemas']['Timestamp'];
          state: components['schemas']['GoalRunState'];
        };
      };
    };
    /**
     * GoalBudget
     * @description 一次运行的预算（ADR 0146 §1.2 的默认值）
     */
    GoalBudget: {
      /** @default 12 */
      checks: number;
      /** @default 8388608 */
      code_bytes: number;
      /** @default 200 */
      code_files: number;
      /** @default 30 */
      dbstats_queries: number;
      /** @default 1200 */
      duration_seconds: number;
      /** @default 300 */
      github_requests: number;
      /** @default 10 */
      logs_queries: number;
      /** @default 400000 */
      tokens: number;
      /** @default 10 */
      traces_queries: number;
    };
    /**
     * GoalCreate
     * @description 下达目标的请求体（POST /v1/goals）。origin 由认证上下文决定（控制台会话为 console，API token 为 api，聊天渠道的确认卡片为 telegram）；budget 只写要改的项，其余取默认值
     */
    GoalCreate: {
      budget?: {
        checks?: number;
        code_bytes?: number;
        code_files?: number;
        dbstats_queries?: number;
        duration_seconds?: number;
        github_requests?: number;
        logs_queries?: number;
        tokens?: number;
        traces_queries?: number;
      };
      cluster_id: components['schemas']['ClusterId'];
      /** @description 有效期，默认 14d，不超过 30d */
      expires_in?: components['schemas']['Duration'];
      objective: null | components['schemas']['GoalObjective'];
      outputs: components['schemas']['RecommendationKind'][];
      subject: components['schemas']['GoalSubject'];
    };
    /**
     * GoalCreatedEvent
     * @description 目标创建（契约 2.28.0）
     */
    GoalCreated: {
      payload: components['schemas']['goal.schema'];
      /** @constant */
      type: 'goal.created';
    } & components['schemas']['Header'];
    /** GoalObjective */
    GoalObjective: {
      comparator: components['schemas']['Comparator'];
      statistic: components['schemas']['IndicatorStatistic'];
      target: number;
      unit: components['schemas']['IndicatorUnit'];
      /** @description 基线窗口，默认 7d，不超过 14d */
      window: components['schemas']['Duration'];
    };
    /**
     * GoalOrigin
     * @description 目标的来源：manual 人工下达；checkup 领域的定期体检；trend 趋势扫描；forecast_alert 预测类告警
     */
    GoalOrigin:
      | {
          /** @enum {string} */
          channel: 'console' | 'telegram' | 'api';
          /** @constant */
          kind: 'manual';
          /** @description 下达目标的主体 id；api 为调用方 id */
          principal: string;
        }
      | {
          domain: components['schemas']['DomainId'];
          /** @constant */
          kind: 'checkup';
          schedule_id: string;
        }
      | {
          entity: components['schemas']['EntityKey'];
          /** @constant */
          kind: 'trend';
          /** @description <包>/<领域>/<趋势 id> */
          trend: string;
        }
      | {
          alert_fingerprint: string;
          /** @constant */
          kind: 'forecast_alert';
        };
    /**
     * GoalRunConcludedEvent
     * @description 目标运行结束（契约 2.28.0），含失败与没有差距
     */
    GoalRunConcluded: {
      payload: {
        goal_id: components['schemas']['Uuid'];
        goal_revision: number;
        /** @description 运行输出；在基线之前失败时为 null */
        output: null | components['schemas']['optimization-output.schema'];
        run_id: components['schemas']['Uuid'];
        summary: components['schemas']['GoalRunSummary'];
      };
      /** @constant */
      type: 'goal.run.concluded';
    } & components['schemas']['Header'];
    /**
     * GoalRunState
     * @description queued 排队；deferred 被准入推迟（defer_reason）；running 执行中；concluded 结束（result）；failed 失败；cancelled 目标取消
     * @enum {string}
     */
    GoalRunState: 'queued' | 'deferred' | 'running' | 'concluded' | 'failed' | 'cancelled';
    /** GoalRunSummary */
    GoalRunSummary: {
      /** @description 本次运行发现或更新的发现数 */
      findings: number;
      finished_at: null | components['schemas']['Timestamp'];
      /** @description 差距是否成立；基线之前为 null */
      gap: boolean | null;
      goal_id: components['schemas']['Uuid'];
      goal_revision: number;
      queued_at: components['schemas']['Timestamp'];
      /** @description deferred 的原因（budget、storm、incident、load_guard、rate_limit、schedule_window）或 failed 的原因（baseline_insufficient、model_unavailable、budget_exhausted、deadline、datasource、internal） */
      reason: string | null;
      /** @description 通过全部门槛的建议数 */
      recommendations: number;
      /** @description concluded 时的结果：no_gap 没有差距（不调用模型）；recommended 有通过门槛的建议；report_only 有发现、没有建议通过门槛；其余状态为 null */
      result: null | ('no_gap' | 'recommended' | 'report_only');
      run_id: components['schemas']['Uuid'];
      started_at: null | components['schemas']['Timestamp'];
      state: components['schemas']['GoalRunState'];
    };
    /**
     * GoalScope
     * @description 范围白名单：组件键与命名空间；两者都为空表示不限
     */
    GoalScope: {
      components: components['schemas']['ComponentKey'][];
      namespaces: string[];
    };
    /** GoalSpec */
    GoalSpec: {
      budget: components['schemas']['GoalBudget'];
      /** @description 目标值；领域体检没有目标值时为 null，差距按领域的门槛（DomainGates.thresholds） */
      objective: null | components['schemas']['GoalObjective'];
      origin: components['schemas']['GoalOrigin'];
      /** @description 允许的建议类别 */
      outputs: components['schemas']['RecommendationKind'][];
      subject: components['schemas']['GoalSubject'];
    };
    /**
     * GoalState
     * @description queued 排队；analyzing 分析中；recommended 有建议已发布；verifying 验证中；achieved 达成；not_achieved 验证后未达成；no_action 没有差距或没有通过门槛的建议；cancelled 取消；expired 到期；failed 失败（state_reason 写明原因）
     * @enum {string}
     */
    GoalState:
      | 'queued'
      | 'analyzing'
      | 'recommended'
      | 'verifying'
      | 'achieved'
      | 'not_achieved'
      | 'no_action'
      | 'cancelled'
      | 'expired'
      | 'failed';
    /**
     * GoalSubject
     * @description 目标对象：一个指标（带参数），或一个领域的体检
     */
    GoalSubject:
      | {
          indicator: components['schemas']['IndicatorRef'];
          /** @description 按指标的 params schema 校验 */
          params: {
            [key: string]: number | string | boolean;
          };
          scope: components['schemas']['GoalScope'];
          /** @constant */
          type: 'indicator';
        }
      | {
          domain: components['schemas']['DomainId'];
          scope: components['schemas']['GoalScope'];
          /** @constant */
          type: 'domain';
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
      /** @description 针对这个假设执行完成的区分性检查数（失败的检查不计） */
      checks_run?: number;
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
      /** @description 账本给出状态的依据，按时间顺序，例如“支持卡：card:31、card:38”“相反的正常卡：card:25”“人工反馈确认根因” */
      status_reasons?: string[];
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
      /** @description 最近一次完成的研判给出的根因，读取时由中心附上（ADR 0104 §14）；没有给出根因的研判、事件流与旧版本的事件没有这个字段 */
      research_root?: components['schemas']['ResearchRoot'];
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
        /** ResearchRoot */
        ResearchRoot: {
          component: components['schemas']['ComponentKey'];
          /** @description 研判根因与事件根因按属主粒度比较不一致（Pod 与它所属的 Deployment 算一致）。只标记，事件不拆分，分组与根因不变 */
          mismatch: boolean;
          run_id: components['schemas']['Uuid'];
        };
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
      /** @description 最近一次完成、给出了根因的研判的根因，及它与事件根因是否不一致（ADR 0104 §14）；没有这样的研判时为 null */
      research_root: null | components['schemas']['ResearchRoot'];
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
    /**
     * Indicator
     * @description 目标可以引用的指标。按实体产生序列：基线、差距与验证在指标的信号上按小时取值；目标不提交自由查询
     */
    Indicator: {
      /**
       * @description 改善方向
       * @enum {string}
       */
      better: 'lower' | 'higher';
      description?: components['schemas']['LocalizedText'];
      /** @description 实体类型：Kubernetes 的 Kind（其他 API 组写作 Kind.group），或逻辑实体 pg_statement、pg_table、pg_index、route、stage */
      entity: string;
      /** @description 包内唯一；全局 id 为 <包>/<id> */
      id: string;
      /** @description 判定业务高峰用的负载指标（例如请求速率），用于基线覆盖与验证时的时段匹配；不填时不检查高峰 */
      load_indicator?: components['schemas']['IndicatorRef'];
      /** @description 参数的 JSON Schema（可移植子集：type: object、additionalProperties: false，字符串用 enum 或 pattern 限定，数字有 minimum 与 maximum）。信号中写作 $params.<名字> */
      params?: {
        /** @constant */
        additionalProperties?: false;
        properties: Record<string, never>;
        /** @constant */
        type: 'object';
      };
      /** @description metrics 信号 <pack>/<signal id>（同包内可省略 <pack>/）；查询按实体与 params 渲染，结果是一条或多条序列，多条时取和 */
      signal: string;
      statistic: components['schemas']['IndicatorStatistic'];
      title: components['schemas']['LocalizedText'];
      unit: components['schemas']['IndicatorUnit'];
    };
    /**
     * IndicatorRef
     * @description 指标的全局 id <包>/<指标 id>，例如 postgres/db-time
     */
    IndicatorRef: string;
    /**
     * IndicatorStatistic
     * @description 基线窗口内按小时取值之后的统计方式
     * @enum {string}
     */
    IndicatorStatistic: 'p50' | 'p95' | 'max';
    /**
     * IndicatorUnit
     * @enum {string}
     */
    IndicatorUnit: 'none' | 'percent' | 'ratio' | 'bytes' | 'seconds' | 'count' | 'per_second' | 'cores';
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
      /**
       * @description dbstats：数据库统计视图（契约 2.28.0）
       * @enum {string}
       */
      category:
        | 'alerts'
        | 'metrics'
        | 'logs'
        | 'traces'
        | 'changes'
        | 'notify'
        | 'approve'
        | 'identity'
        | 'model'
        | 'execute'
        | 'dbstats';
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
      /** @description outcome 为 failed 时的原因（参数被拒绝、数据源报错、结果无法判定成卡） */
      error?: string | null;
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
      /** @description Pod 容器的镜像（kube_pod_container_info 的 image 与 image_id），去重后按字典序；只有 Pod 节点填写，用于把发布之前的 Job 关联到发布（ADR 0104 §13） */
      images?: string[];
      key: components['schemas']['ComponentKey'];
      kind: string;
      labels: components['schemas']['Labels'];
      name: string;
      namespace: string | null;
      uid: string | null;
    };
    /** EvidenceNovelty */
    Novelty: {
      /** @description 得出结论的基线样本中判为异常的比例；没有样本时为 null */
      abnormal_share: number | null;
      /** @description 固定的对照时段（默认事件前 1 小时、24 小时、7 天的同一时段）上的判定与主值 */
      comparisons: components['schemas']['NoveltyComparison'][];
      /** @description 基线样本主值的分位区间 [1 − quantile, quantile]；有主值的样本不足时为 null */
      range: null | {
        high: number;
        low: number;
        quantile: number;
      };
      /** @description 判定说明 */
      reason: string;
      /** @description 判为常态所依据的规则：abnormal_share 基线样本中判为异常的比例不低于门槛；within_range 主值落在基线样本主值的分位区间内；below_ratio 计数或速率类主值与对照时段的最大值相差不到门槛倍数。不是常态时为 null */
      rule: null | ('abnormal_share' | 'within_range' | 'below_ratio');
      /** @description 得出结论（正常或异常）的基线样本数，含对照时段 */
      samples: number;
      /**
       * @description novel：与基线相比明显异常；routine：常态，与基线相比没有明显升高；unknown：得出结论的基线样本不足（更早的时段没有数据、超出保留期，或在期限内没有完成）
       * @enum {string}
       */
      status: 'novel' | 'routine' | 'unknown';
      /** @description 事件窗口内的主值（value_number） */
      value: number | null;
    };
    /**
     * EvidenceNoveltyComparison
     * @description 一个对照时段：offset 为它相对事件窗口提前的时长
     */
    NoveltyComparison: {
      offset: components['schemas']['Duration'];
      /** @description 对照时段的主值；没有主值时为 null */
      value: number | null;
      verdict: components['schemas']['Verdict'];
      window: components['schemas']['TimeWindow'];
    };
    /**
     * OptimizationOutput
     * @description 一次目标运行经代码校验后的输出（契约 2.28.0，ADR 0146 §2）：基线、差距、候选发现、按发现分组的账本、每个发现的结论、建议与门槛记录、validation_notes。baseline、gap、candidates 与 recommendations 的数值全部由代码从信号卡计算；模型只提出假设、选择检查并写说明。没有差距时整次运行不调用模型，ledger 与 conclusions 为空
     */
    'optimization-output.schema': {
      baseline: components['schemas']['Baseline'];
      /** @description 候选发现，按“份额 × 差距”降序；前 3 个 selected 为 true，进入假设；其余为“未分析的候选” */
      candidates: components['schemas']['Candidate'][];
      /** @description 诊断卡、份额卡与区分性检查产生的证据卡（编号见 evidence_index），序列为空数组 */
      check_cards: components['schemas']['evidence-result.schema'][];
      /** @description 每个进入假设的发现一条，档位由代码按 ADR 0146 §2.4 计算 */
      conclusions: components['schemas']['FindingConclusion'][];
      /** @description 运行内的证据引用到定义与实体的映射：card:<n> → <card_id>@<实体键> */
      evidence_index: {
        ref: components['schemas']['EvidenceRef'];
        target: string;
      }[];
      gap: components['schemas']['Gap'];
      goal_id: components['schemas']['Uuid'];
      goal_revision: number;
      /** @description 假设账本：root_component 为发现挂到的组件，finding 给出分组键；同一发现上的假设互为竞争假设 */
      hypotheses: components['schemas']['FindingHypothesis'][];
      next_checks: components['schemas']['NextCheck'][];
      /** @description 本次运行评估过的建议与门槛记录（每次运行最多 2 个通过全部门槛） */
      recommendations: components['schemas']['RecommendationAttempt'][];
      run_id: components['schemas']['Uuid'];
      /**
       * @description 检验循环的停止原因（取值同 ResearchOutput.stop_reason）；没有差距时为 null
       * @enum {string|null}
       */
      stop_reason: 'leader_supported' | 'no_change' | 'step_limit' | 'deadline' | 'budget' | 'model_unavailable' | null;
      /** @description 【模型】本次分析的说明；没有调用模型时为代码生成的说明 */
      summary: string;
      /** @description 代码校验的修改记录：删除的无效证据引用、拒绝的未知模板与原始查询、降级的结论、删除的无法核实的数值等 */
      validation_notes: string[];
      $defs: {
        /** OptimizationBaseline */
        Baseline: {
          indicators: components['schemas']['BaselineIndicator'][];
          /** @description 基线不足时缺少的数据（例如“postgres/db-time 覆盖率 72%”） */
          missing: string[];
          /** @description 覆盖率不低于 90% 且至少 3 个业务高峰；否则运行以 failed（baseline_insufficient）结束 */
          sufficient: boolean;
          window: components['schemas']['TimeWindow'];
        };
        /** BaselineIndicator */
        BaselineIndicator: {
          /** @enum {string} */
          better: 'lower' | 'higher';
          covered_hours: number;
          entity: components['schemas']['EntityKey'];
          /** @description 按小时的取值 [unix 秒, 值或 null]，控制台画基线图 */
          hourly: [number, number | null][];
          hours: number;
          indicator: components['schemas']['IndicatorRef'];
          params: {
            [key: string]: number | string | boolean;
          };
          /** @description 按负载指标判定的业务高峰小时数（负载前 20%） */
          peak_hours: number;
          statistic: components['schemas']['IndicatorStatistic'];
          unit: components['schemas']['IndicatorUnit'];
          /** @description 统计值；没有数据时为 null */
          value: number | null;
          /** @description 违反目标或门槛的小时占比；没有目标与门槛时为 null */
          violation_ratio: number | null;
        };
        /** OptimizationGap */
        Gap: {
          /**
           * @description objective 按目标值；gate 按领域门槛；none 基线不足或没有可比较的目标
           * @enum {string}
           */
          basis: 'objective' | 'gate' | 'none';
          detail: string;
          exists: boolean;
        };
        /** OptimizationCandidate */
        Candidate: {
          card_ref: components['schemas']['EvidenceRef'];
          component: components['schemas']['ComponentKey'];
          /** @description <领域>/<诊断卡 id> */
          diagnostic: string;
          entity: components['schemas']['FindingEntity'];
          /** @description 发现指纹 */
          finding: components['schemas']['Sha256'];
          gap: number | null;
          kind: string;
          score: number;
          selected: boolean;
          share: number | null;
          share_ref: null | components['schemas']['EvidenceRef'];
          /**
           * @description 没有进入假设的原因：rank（排在前 3 之外）、verifying（已修复的发现在验证期内）、cooldown
           * @enum {string|null}
           */
          skipped_reason: 'rank' | 'verifying' | 'cooldown' | null;
        };
        /** FindingHypothesis */
        FindingHypothesis: {
          finding: components['schemas']['Sha256'];
          hypothesis: components['schemas']['Hypothesis'];
        };
        /**
         * OptimizationConsistency
         * @description 优化场景的 evidence_consistent 条件逐项结果（ADR 0146 §2.4）；trend_onset 只对趋势触发的目标求值，其余为 null
         */
        OptimizationConsistency: {
          competitor_tested: boolean;
          gap_holds: boolean;
          no_contrary_normal: boolean;
          share_holds: boolean;
          trend_onset: boolean | null;
        };
        /** FindingConclusion */
        FindingConclusion: {
          /** @enum {string} */
          chosen_by: 'model' | 'ledger';
          consistency: components['schemas']['OptimizationConsistency'];
          contrary_refs: components['schemas']['EvidenceRef'][];
          finding: components['schemas']['Sha256'];
          hypothesis_id: string | null;
          level: components['schemas']['ConclusionLevel'];
          /** @description 【模型】选择这个假设的说明 */
          note: string | null;
          share_refs: components['schemas']['EvidenceRef'][];
          support_refs: components['schemas']['EvidenceRef'][];
          undetermined_reason: string | null;
        };
        /** RecommendationAttempt */
        RecommendationAttempt: {
          finding: components['schemas']['Sha256'];
          gates: components['schemas']['GateRecord'][];
          kind: components['schemas']['RecommendationKind'];
          passed: boolean;
          /** @description 保存的建议；没有保存时为 null */
          recommendation_id: null | components['schemas']['Uuid'];
          template: string;
        };
      };
    };
    /**
     * OptimizationConsistency
     * @description 优化场景的 evidence_consistent 条件逐项结果（ADR 0146 §2.4）；trend_onset 只对趋势触发的目标求值，其余为 null
     */
    OptimizationConsistency: {
      competitor_tested: boolean;
      gap_holds: boolean;
      no_contrary_normal: boolean;
      share_holds: boolean;
      trend_onset: boolean | null;
    };
    /**
     * OutcomeVerifiedEvent
     * @description 建议的验证结束（契约 2.28.0）
     */
    OutcomeVerified: {
      payload: {
        finding: components['schemas']['Sha256'];
        goal_id: components['schemas']['Uuid'];
        outcome: components['schemas']['RecommendationOutcome'];
        recommendation_id: components['schemas']['Uuid'];
      };
      /** @constant */
      type: 'outcome.verified';
    } & components['schemas']['Header'];
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
      /** @description 提议的主体（契约 2.28.0）；不填时为事件。主体为目标时 incident_id 为目标 id，绑定字段的语义见 Binding */
      subject?: components['schemas']['Subject'];
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
        /**
         * ProposalBinding
         * @description 主体为事件时是事件版本、根因组件与阶段 A 的证据指纹；主体为目标时（契约 2.28.0）incident_version 取目标的 revision，root_component 取发现挂到的组件，evidence_fingerprint 取发现的证据指纹。审批断言 v1 与 gateway 的绑定核对不变
         */
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
          /** @description 提议的主体（契约 2.28.0）；不填时为事件。主体为目标时 incident_id 必须等于 subject.id */
          subject?: components['schemas']['Subject'];
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
      /** @description 提议的主体（契约 2.28.0）；不填时为事件。主体为目标时 incident_id 必须等于 subject.id */
      subject?: components['schemas']['Subject'];
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
     * OptimizationRecommendation
     * @description 主动优化的建议（契约 2.28.0，ADR 0146 §1.5、§2.5、§2.6）：ops 仓库的 PR（经 gitops_pr 提议）或业务仓库的 issue。预期收益与验证计划在创建时由代码确定；模型写的文字只在 model_note 中，消息与控制台标注【模型】
     */
    'recommendation.schema': {
      cluster_id: components['schemas']['ClusterId'];
      created_at: components['schemas']['Timestamp'];
      /** @description 创建的 PR 或 issue；门槛不通过或还没有创建时为 null */
      delivery: null | components['schemas']['Delivery'];
      estimate: components['schemas']['EstimateValue'];
      /** @description 发现的指纹 */
      finding: components['schemas']['Sha256'];
      /** @description G1–G6 的逐项结果（按顺序，遇到第一个不通过即停止）；全部通过才创建 PR 或 issue */
      gates: components['schemas']['GateRecord'][];
      goal_id: components['schemas']['Uuid'];
      kind: components['schemas']['RecommendationKind'];
      level: components['schemas']['ConclusionLevel'];
      /** @description 模型补充的说明（经数值审计），显示时标注【模型】 */
      model_note: string | null;
      /** @description 验证结果；验证结束之前为 null */
      outcome: null | components['schemas']['RecommendationOutcome'];
      recommendation_id: components['schemas']['Uuid'];
      run_id: components['schemas']['Uuid'];
      state: components['schemas']['RecommendationState'];
      /** @description <pack>/<模板 id>：ops_pr 为 remediations.yaml 中 applies 为 goal 的模板，business_issue 为 issues.yaml 的模板 */
      template: string;
      title: string;
      updated_at: components['schemas']['Timestamp'];
      verify: components['schemas']['VerifyPlan'];
      $defs: {
        /**
         * RecommendationState
         * @description blocked 门槛不通过，只记录原因；open 通过门槛，PR 或 issue 创建中；recommended PR 或 issue 已创建；verifying PR 合并并同步或修复已部署，验证窗口中；improved、no_effect、regressed 验证结果；rejected issue 以 not planned 关闭、PR 未合并即关闭，或被标为建议无用；superseded 发现有了更新的建议；failed 创建失败
         * @enum {string}
         */
        RecommendationState:
          | 'blocked'
          | 'open'
          | 'recommended'
          | 'verifying'
          | 'improved'
          | 'no_effect'
          | 'regressed'
          | 'rejected'
          | 'superseded'
          | 'failed';
        /**
         * EstimateValue
         * @description 模板 estimate 的求值结果：lower 为保守下界，expected 为期望值，单位与指标相同，按改善方向取正值
         */
        EstimateValue: {
          basis: string;
          expected: number | null;
          indicator: components['schemas']['IndicatorRef'];
          lower: number;
          unit: components['schemas']['IndicatorUnit'];
        };
        /**
         * VerifyPlan
         * @description 验证计划（ADR 0146 §2.6）：start 为 merged_synced 时等管理这个文件的 Argo 应用的同步版本包含合并提交且 Healthy（GUC 另外核对 pg_settings）；为 deployed 时等发布输入的版本对应的业务提交包含修复提交。窗口开始后与基线按“星期 × 小时”匹配的时段比较
         */
        VerifyPlan: {
          /** @description 应转为正常的卡片全局 id */
          cards: string[];
          guards: components['schemas']['IndicatorRef'][];
          indicator: components['schemas']['IndicatorRef'];
          params: {
            [key: string]: number | string | boolean;
          };
          /** @description GUC：应在 pg_settings 中生效的参数 → 新值 */
          settings: {
            [key: string]: string;
          };
          /** @enum {string} */
          start: 'merged_synced' | 'deployed';
          /** @description 验证窗口；开始之前为 null */
          window: null | components['schemas']['TimeWindow'];
          within: components['schemas']['Duration'];
        };
        /** GateRecord */
        GateRecord: {
          /** @description 机器可读的原因码，与 remediation_attempts 的方式相同；G3 不通过时为模板 guard 的 id */
          code: string;
          detail: string;
          /**
           * @description G1 证据档位；G2 预期收益；G3 安全约束；G4 新颖性；G5 数量；G6 时机
           * @enum {string}
           */
          gate: 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6';
          passed: boolean;
        };
        /** RecommendationDelivery */
        Delivery: {
          /** @description ops_pr 的分支 srenautix/goal-… */
          branch: string | null;
          /** @description issue 的关闭原因或 PR 未合并就关闭（unmerged）；未关闭时为 null */
          closed_reason: null | ('completed' | 'not_planned' | 'unmerged');
          merge_commit: string | null;
          merged_at: null | components['schemas']['Timestamp'];
          /** @description PR 或 issue 号；PR 还没有创建时为 null */
          number: number | null;
          /** @description ops_pr 的 gitops_pr 提议；business_issue 为 null */
          proposal_id: null | components['schemas']['Uuid'];
          repository: string;
          /**
           * @description ops：ops 仓库（只经 gateway 的 gitops_pr）；business：业务仓库（只创建 issue 与评论）
           * @enum {string}
           */
          repository_role: 'ops' | 'business';
          url: string | null;
        };
        /**
         * RecommendationOutcome
         * @description 合并或部署之后的验证结果（ADR 0146 §2.6）：改善不低于预期下界的 50% 并超出噪声带为 improved；守护指标恶化超过 10% 为 regressed；其余为 no_effect
         */
        RecommendationOutcome: {
          /** @description 匹配时段的基线统计值 */
          baseline: number | null;
          /** @description verify.cards 在窗口结束时的结论 */
          cards: {
            card_id: string;
            verdict: components['schemas']['Verdict'];
          }[];
          estimate_lower: number;
          guards: {
            /** @description 恶化方向为正 */
            change_ratio: number | null;
            indicator: components['schemas']['IndicatorRef'];
            regressed: boolean;
          }[];
          /** @description 按改善方向取正值，单位与指标相同 */
          improvement: number | null;
          /** @description 基线窗口内同一时段的四分位距的一半 */
          noise_band: number | null;
          /** @description 验证窗口的统计值 */
          observed: number | null;
          /** @enum {string} */
          result: 'improved' | 'no_effect' | 'regressed';
          /** @description regressed 的 ops PR 由 server 提交的 revert 提议 */
          revert_proposal_id: null | components['schemas']['Uuid'];
          verified_at: components['schemas']['Timestamp'];
          window: components['schemas']['TimeWindow'];
        };
      };
    };
    /** RecommendationAttempt */
    RecommendationAttempt: {
      finding: components['schemas']['Sha256'];
      gates: components['schemas']['GateRecord'][];
      kind: components['schemas']['RecommendationKind'];
      passed: boolean;
      /** @description 保存的建议；没有保存时为 null */
      recommendation_id: null | components['schemas']['Uuid'];
      template: string;
    };
    /**
     * RecommendationKind
     * @description ops_pr：ops 仓库的 PR（gitops_pr 提议）；business_issue：业务仓库的 issue
     * @enum {string}
     */
    RecommendationKind: 'ops_pr' | 'business_issue';
    /**
     * RecommendationOutcome
     * @description 合并或部署之后的验证结果（ADR 0146 §2.6）：改善不低于预期下界的 50% 并超出噪声带为 improved；守护指标恶化超过 10% 为 regressed；其余为 no_effect
     */
    RecommendationOutcome: {
      /** @description 匹配时段的基线统计值 */
      baseline: number | null;
      /** @description verify.cards 在窗口结束时的结论 */
      cards: {
        card_id: string;
        verdict: components['schemas']['Verdict'];
      }[];
      estimate_lower: number;
      guards: {
        /** @description 恶化方向为正 */
        change_ratio: number | null;
        indicator: components['schemas']['IndicatorRef'];
        regressed: boolean;
      }[];
      /** @description 按改善方向取正值，单位与指标相同 */
      improvement: number | null;
      /** @description 基线窗口内同一时段的四分位距的一半 */
      noise_band: number | null;
      /** @description 验证窗口的统计值 */
      observed: number | null;
      /** @enum {string} */
      result: 'improved' | 'no_effect' | 'regressed';
      /** @description regressed 的 ops PR 由 server 提交的 revert 提议 */
      revert_proposal_id: null | components['schemas']['Uuid'];
      verified_at: components['schemas']['Timestamp'];
      window: components['schemas']['TimeWindow'];
    };
    /**
     * RecommendationState
     * @description blocked 门槛不通过，只记录原因；open 通过门槛，PR 或 issue 创建中；recommended PR 或 issue 已创建；verifying PR 合并并同步或修复已部署，验证窗口中；improved、no_effect、regressed 验证结果；rejected issue 以 not planned 关闭、PR 未合并即关闭，或被标为建议无用；superseded 发现有了更新的建议；failed 创建失败
     * @enum {string}
     */
    RecommendationState:
      | 'blocked'
      | 'open'
      | 'recommended'
      | 'verifying'
      | 'improved'
      | 'no_effect'
      | 'regressed'
      | 'rejected'
      | 'superseded'
      | 'failed';
    /**
     * RecommendationUpdatedEvent
     * @description 建议创建或状态变化（契约 2.28.0）
     */
    RecommendationUpdated: {
      payload: components['schemas']['recommendation.schema'];
      /** @constant */
      type: 'recommendation.updated';
    } & components['schemas']['Header'];
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
      /** @description 主体为目标时（契约 2.28.0）incident_id 为目标 id、incident_version 为目标的 revision；不填时为事件 */
      subject?: components['schemas']['Subject'];
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
          categories: components['schemas']['EgressCategory'][];
          /** @description 不在 llm.egress.categories 中、进入提示词之前删除的片段数，按类别计（契约 2.28.0，ADR 0146 §3.6）；没有删除时不填或为空对象 */
          dropped?: {
            [key: string]: number;
          };
          in_domain: boolean;
          redaction_hits: number;
          route_id: string;
        };
        /**
         * EgressCategory
         * @description 出境数据类别。sql：规范化语句文本（常量为 $n、去掉注释）；code：业务代码片段（契约 2.28.0，ADR 0146 §3.6）
         * @enum {string}
         */
        EgressCategory:
          'metrics' | 'logs' | 'traces' | 'events' | 'topology' | 'changes' | 'alerts' | 'knowledge' | 'sql' | 'code';
      };
    };
    /**
     * ResearchOutput
     * @description 一次研判经代码校验后的输出（DESIGN §7.2、§7.3），由 worker 写入 research_runs 并随 research.concluded 发布。模型直接输出的部分见 contract/model/；本结构加入假设账本状态、区分性检查结果、代码判定的结论阶梯和校验记录
     */
    'research-output.schema': {
      /** @description 区分性检查产生的证据卡（引用编号接在阶段 A 的卡之后），序列为空数组；完整序列在 worker 的运行明细中 */
      check_cards?: components['schemas']['evidence-result.schema'][];
      conclusion: components['schemas']['Conclusion'];
      disposition: components['schemas']['Disposition'];
      /** @description 研判运行内的证据引用到定义与实体的映射（同研判清单的 evidence_map）：卡为 <card_id>@<实体键>，告警为 alert_id，变更为 change_id */
      evidence_index?: {
        ref: components['schemas']['EvidenceRef'];
        target: string;
      }[];
      hypotheses: components['schemas']['Hypothesis'][];
      /** @description 结论由兜底路由（ModelRoute.role 为 last_resort）给出时填写：全部常规路由都因事件涉及其故障域而提前熔断（契约 2.30.0，ADR 0152）。常规路由给出结论时不填 */
      last_resort_route?: {
        model: string;
        route_id: string;
      };
      next_checks: components['schemas']['NextCheck'][];
      proposals: components['schemas']['ProposalDraft'][];
      recommendations: components['schemas']['Recommendation'][];
      situation: string;
      /**
       * @description 检验循环的停止原因：leader_supported 第一的假设得到支持且竞争假设都已推翻或检验后无法判定；no_change 连续两步没有变化或没有可执行的检查；step_limit、deadline、budget 达到步数、期限或预算上限；model_unavailable 模型不可用；指纹不变直接沿用上一次研判时为 no_change
       * @enum {string|null}
       */
      stop_reason?:
        'leader_supported' | 'no_change' | 'step_limit' | 'deadline' | 'budget' | 'model_unavailable' | null;
      summary: string;
      /** @description 代码校验的修改记录：删除的无效证据引用、删除的目录外提议、降级的结论、删除的无法核实的数值等 */
      validation_notes: string[];
      $defs: {
        /** ResearchConclusion */
        Conclusion: {
          consistency: components['schemas']['ConsistencyChecks'];
          consistency_detail?: components['schemas']['ConsistencyDetail'];
          hypothesis_id: string | null;
          level: components['schemas']['ConclusionLevel'];
          root_component: null | components['schemas']['ComponentKey'];
          undetermined_reason: string | null;
        };
        /**
         * ConsistencyDetail
         * @description 四个条件各自的依据，由结论阶梯的代码给出：支持卡、支持的成员告警、最早的异常起点、症状起点与容差、相反的正常卡、检验过与同样得到支持的竞争假设、结论由谁选中
         */
        ConsistencyDetail: {
          /**
           * @description model：模型在 conclude 中选中；ledger：模型弃权，由代码按账本选中（ADR 0120，档位最高为 likely）
           * @enum {string}
           */
          chosen_by: 'model' | 'ledger';
          contrary_refs: components['schemas']['EvidenceRef'][];
          /** @description 由小模型判定的支持卡（只能支持 likely） */
          model_judged_refs: components['schemas']['EvidenceRef'][];
          /** @description 支持卡中最早的异常起点；没有可确定起点的支持卡时为 null */
          onset: null | {
            at: components['schemas']['Timestamp'];
            ref: components['schemas']['EvidenceRef'];
          };
          /** @description 计入支持的成员告警（ADR 0122）；只有它们支持时档位最高为 likely */
          support_alerts: components['schemas']['EvidenceRef'][];
          /** @description 由领域包规则判定、实体在假设范围内的异常卡 */
          support_refs: components['schemas']['EvidenceRef'][];
          /** @description 同样处于支持状态的竞争假设（ADR 0124）；不为空时第 4 个条件不满足 */
          supported_competitors: string[];
          /** @description 症状起点：最早触发的 symptom 角色成员告警，没有时为事件首次触发时间 */
          symptom_onset_at: components['schemas']['Timestamp'];
          /** @description 执行过检查或已被推翻的竞争假设 */
          tested_competitors: string[];
          tolerance_seconds: number;
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
          /** @description 针对这个假设执行完成的区分性检查数（失败的检查不计） */
          checks_run?: number;
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
          /** @description 账本给出状态的依据，按时间顺序，例如“支持卡：card:31、card:38”“相反的正常卡：card:25”“人工反馈确认根因” */
          status_reasons?: string[];
          supporting: components['schemas']['EvidenceRef'][];
        };
        /** NextCheck */
        NextCheck: {
          args: {
            [key: string]: unknown;
          };
          /** @description outcome 为 failed 时的原因（参数被拒绝、数据源报错、结果无法判定成卡） */
          error?: string | null;
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
      | 'resumed'
      | 'reopened';
    /** ResearchRoot */
    ResearchRoot: {
      component: components['schemas']['ComponentKey'];
      /** @description 研判根因与事件根因按属主粒度比较不一致（Pod 与它所属的 Deployment 算一致）。只标记，事件不拆分，分组与根因不变 */
      mismatch: boolean;
      run_id: components['schemas']['Uuid'];
    };
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
      /** @description 成员告警的最低取证集合（契约 2.31.0，ADR 0153）：目录条目声明了 required_cards、能解析出实体的在场成员告警，每条一项。旧版本的报告没有这个字段 */
      required_evidence?: {
        alert_id: string;
        alertname: string;
        /** @description 最低取证集合中的卡（<pack>/<chain>/<card>） */
        cards: string[];
        /** @description <pack>/<条目 id> */
        catalog_entry: string;
        entity: components['schemas']['EntityRef'];
        /** @description 阶段 A 没有在告警实体上得出结论（没有执行，或无法判定）的卡 */
        missing: string[];
      }[];
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
    /**
     * Subject
     * @description 研判、提议、出境清单与消息的主体（契约 2.28.0，ADR 0146 §8）：incident 事件；goal 主动优化的目标。没有 subject 的旧数据都是事件。主体为 goal 时沿用的事件字段语义为：incident_id 取目标 id，incident_version 取目标的 revision
     */
    Subject: {
      id: components['schemas']['Uuid'];
      /** @enum {string} */
      type: 'incident' | 'goal';
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
    /** @description 拓扑覆盖规则的 gitops_pr 提议（PR 在提议批准后由 gateway 开出，地址见提议的执行与事件 issue） */
    TopologyOverrideProposal: {
      /** @description 控制台的审批页 */
      approval_url: string;
      /** @description 补丁基于的 base 分支提交（gateway 的 base_head 预检核对它） */
      base_sha: string;
      branch: string;
      incident_id: components['schemas']['Uuid'];
      /** @description 关联的事件 issue；没有开启事件 issue，或 issue 暂时没能开出时为 null */
      issue_url: string | null;
      proposal_id: components['schemas']['Uuid'];
      state: components['schemas']['State'];
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
    /**
     * VerifyPlan
     * @description 验证计划（ADR 0146 §2.6）：start 为 merged_synced 时等管理这个文件的 Argo 应用的同步版本包含合并提交且 Healthy（GUC 另外核对 pg_settings）；为 deployed 时等发布输入的版本对应的业务提交包含修复提交。窗口开始后与基线按“星期 × 小时”匹配的时段比较
     */
    VerifyPlan: {
      /** @description 应转为正常的卡片全局 id */
      cards: string[];
      guards: components['schemas']['IndicatorRef'][];
      indicator: components['schemas']['IndicatorRef'];
      params: {
        [key: string]: number | string | boolean;
      };
      /** @description GUC：应在 pg_settings 中生效的参数 → 新值 */
      settings: {
        [key: string]: string;
      };
      /** @enum {string} */
      start: 'merged_synced' | 'deployed';
      /** @description 验证窗口；开始之前为 null */
      window: null | components['schemas']['TimeWindow'];
      within: components['schemas']['Duration'];
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
    GoalId: components['schemas']['Uuid'];
    /** @description incident_id、稳定标签或别名；标签放进路径时按 RFC 3986 编码 */
    IncidentRef: string;
    /** @description 只用于 Grafana 插件 token：Grafana 用户的邮箱 */
    OnBehalfOf: string;
    ProposalId: components['schemas']['Uuid'];
    RecommendationId: components['schemas']['Uuid'];
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
  lookupAlert: {
    parameters: {
      query: {
        /** @description 只在这个集群的告警中查找；不填时取全部集群中开始时间最晚的一条 */
        cluster_id?: components['schemas']['ClusterId'];
        /**
         * @description 告警的标签，每个标签一个查询参数 `l.<标签名>=<标签值>`（例如 `l.alertname=KubePodCrashLooping&l.namespace=shop`），
         *     必须有 `l.alertname`；同一个标签出现两次时返回 400。除 `l.` 参数与 cluster_id 以外的参数返回 400
         */
        labels: {
          [key: string]: string;
        };
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 查找结果 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['AlertLookup'];
        };
      };
      400: components['responses']['Error'];
      401: components['responses']['Error'];
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
          /** @description 本地管理员要求 TOTP 时（默认，见 listAuthProviders 的 local_admin.totp_required）必填；关闭时可以省略，提交了也不校验 */
          totp?: string;
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
              /** @description 登录是否要求 TOTP（identity.local_admin.totp_required）。为 false 时只凭口令登录，控制台显示"TOTP 已关闭"； H 档审批的重新认证仍要求口令加 TOTP */
              totp_required: boolean;
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
  listFindings: {
    parameters: {
      query?: {
        cluster_id?: components['schemas']['ClusterId'];
        component?: components['schemas']['ComponentKey'];
        cursor?: string;
        domain?: components['schemas']['DomainId'];
        goal_id?: components['schemas']['Uuid'];
        limit?: number;
        status?: components['schemas']['FindingStatus'];
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 发现 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            items: components['schemas']['finding.schema'][];
            next_cursor: string | null;
          };
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
  listGoals: {
    parameters: {
      query?: {
        cluster_id?: components['schemas']['ClusterId'];
        cursor?: string;
        domain?: components['schemas']['DomainId'];
        limit?: number;
        /** @description 只返回未结束的目标 */
        open?: boolean;
        state?: components['schemas']['GoalState'];
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 目标 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            items: components['schemas']['goal.schema'][];
            next_cursor: string | null;
          };
        };
      };
      400: components['responses']['Error'];
    };
  };
  createGoal: {
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
        'application/json': components['schemas']['GoalCreate'];
      };
    };
    responses: {
      /** @description 已创建并入队 */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['goal.schema'];
        };
      };
      400: components['responses']['Error'];
      403: components['responses']['Error'];
      429: components['responses']['Error'];
    };
  };
  getGoal: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        goal_id: components['parameters']['GoalId'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 目标 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['goal.schema'];
        };
      };
      404: components['responses']['Error'];
    };
  };
  cancelGoal: {
    parameters: {
      query?: never;
      header?: {
        /** @description 会话认证时必填；Bearer 认证时不需要 */
        'X-CSRF-Token'?: components['parameters']['CsrfOptional'];
      };
      path: {
        goal_id: components['parameters']['GoalId'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 取消后的目标 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['goal.schema'];
        };
      };
      404: components['responses']['Error'];
      409: components['responses']['Error'];
    };
  };
  listGoalRuns: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        goal_id: components['parameters']['GoalId'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 目标的全部运行（新的在前） */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['GoalRunSummary'][];
        };
      };
      404: components['responses']['Error'];
    };
  };
  getGoalRun: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        goal_id: components['parameters']['GoalId'];
        run_id: components['parameters']['RunId'];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 运行明细 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @description 运行输出；未结束或在基线之前失败时为 null */
            output: null | components['schemas']['optimization-output.schema'];
            summary: components['schemas']['GoalRunSummary'];
          };
        };
      };
      404: components['responses']['Error'];
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
  getOptimizationCatalog: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 指标与领域目录 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            domains: {
              id: components['schemas']['DomainId'];
              indicators: components['schemas']['IndicatorRef'][];
              packs: string[];
              title: components['schemas']['LocalizedText'];
            }[];
            indicators: {
              definition: components['schemas']['Indicator'];
              id: components['schemas']['IndicatorRef'];
            }[];
          };
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
  listRecommendations: {
    parameters: {
      query?: {
        cursor?: string;
        finding?: components['schemas']['Sha256'];
        goal_id?: components['schemas']['Uuid'];
        kind?: components['schemas']['RecommendationKind'];
        limit?: number;
        state?: components['schemas']['RecommendationState'];
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 建议 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            items: components['schemas']['recommendation.schema'][];
            next_cursor: string | null;
          };
        };
      };
      400: components['responses']['Error'];
    };
  };
  rejectRecommendation: {
    parameters: {
      query?: never;
      header: {
        'X-CSRF-Token': components['parameters']['Csrf'];
      };
      path: {
        recommendation_id: components['parameters']['RecommendationId'];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          reason: string | null;
        };
      };
    };
    responses: {
      /** @description 更新后的建议 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['recommendation.schema'];
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
          /** @description 提议绑定的事件；省略时取包含这条告警的最近一个事件 */
          incident_id?: components['schemas']['Uuid'];
          role: components['schemas']['AlertRole'];
        };
      };
    };
    responses: {
      /** @description 同一条规则的提议已经存在 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['TopologyOverrideProposal'];
        };
      };
      /** @description 已提交 gitops_pr 提议 */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['TopologyOverrideProposal'];
        };
      };
      404: components['responses']['Error'];
      409: components['responses']['Error'];
      503: components['responses']['Error'];
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
