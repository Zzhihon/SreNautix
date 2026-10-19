import type { EvidenceResult } from '@srenautix/contract';
import type { QueryRunContext, QueryRunner } from './checks.js';
import { HubError, type HubClient } from './hub.js';
import type { CheckTemplate } from './types.js';

/**
 * 日常研判的查询模板执行：交给 server（POST /v1/research/tasks/{run_id}/query），由 server 的领域包运行时在
 * 假设的根因上执行模板附带的卡并判定。worker 不直接访问数据源。
 * server 拒绝的请求（参数或组件不合法、模板已不存在）以无法判定的卡返回，原因写进卡的说明，研判照常继续。
 */
export class HubQueryRunner implements QueryRunner {
  constructor(
    private readonly hub: HubClient,
    private readonly runId: string,
  ) {}

  async run(template: CheckTemplate, args: Record<string, unknown>, ctx: QueryRunContext): Promise<EvidenceResult> {
    try {
      return await this.hub.runTemplate(this.runId, template.id, args, ctx.rootComponent, ctx.signal);
    } catch (e) {
      if (!(e instanceof HubError) || e.status >= 500) {
        throw e;
      }
      const now = new Date().toISOString();
      // 模板 id 为 <pack>/<id>，卡片 id 与 server 执行时相同：<pack>/templates/<id>
      const slash = template.id.indexOf('/');
      return {
        ref: 'card:1',
        card_id: `${template.id.slice(0, slash)}/templates/${template.id.slice(slash + 1)}`,
        title: { 'zh-CN': template.description, en: template.description },
        threshold: null,
        series: [],
        entity: null,
        window: { from: now, to: now },
        verdict: 'undeterminable',
        display_state: 'undeterminable',
        reason: { kind: 'evaluation_error', text: e.message },
        value: null,
        table: null,
        queries: [],
        egress: 'allow',
        anomaly_started_at: null,
        evaluated_at: now,
      };
    }
  }
}
