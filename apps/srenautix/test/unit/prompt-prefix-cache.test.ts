import { describe, expect, it } from 'vitest';
import { declaredProfile } from '../../src/llm/dialect.js';
import { repairLocally, reaskText } from '../../src/llm/repair.js';
import { bindSchema, modelSchema } from '../../src/llm/schema.js';
import type { LlmRequest, LlmTurn } from '../../src/llm/types.js';
import { schemaInstruction, segmentsText, toChatParams, toResponsesParams } from '../../src/llm/wire.js';
import { PROMPTS } from '../../src/prompts/index.js';
import { incidentBook } from '../../src/research/incident.js';
import { Ledger } from '../../src/research/ledger.js';
import {
  catalogSegment,
  componentChoices,
  concludeItems,
  hypothesizeItems,
  promptParts,
} from '../../src/research/prompt.js';
import { catalogActions, incident, researchCase, stageA, stageACards, subgraph } from '../support/scenario.js';

const deepseek = declaredProfile('deepseek');
const openaiCompat = declaredProfile('openai-compatible');
const responsesCompat = { ...declaredProfile('openai-responses'), strict_json_schema: false };

function makeIncidentA() {
  const base = incident();
  return researchCase({
    incident: {
      ...base,
      incident_id: '00000000-0000-4000-8000-0000000000a1',
      label: 'StatefulSet:shop/postgres:2026-11-22T01:00:00Z',
    },
    templates: [
      { id: 'postgres/wal', description: 'WAL 增长查询', args: { type: 'object', properties: {} } },
      { id: 'workload/restarts', description: '重启查询', args: { type: 'object', properties: {} } },
      {
        id: 'cardcheck:pvc/pvc-usage/fill@PersistentVolumeClaim:shop/data-postgres-0',
        description: 'A 事件卡片检查',
        args: { type: 'object', properties: {} },
      },
    ],
    tools: [
      { name: 'kube_pod_status', description: 'Pod 状态', parameters: { type: 'object', properties: {} } },
      { name: 'kube_events', description: '事件', parameters: { type: 'object', properties: {} } },
    ],
    // 不同子图会有完全不同的动作集合（例如 StatefulSet/Pod 动作 vs Deployment 动作）
    actions: catalogActions(['workload_scale', 'pod_restart']),
    runbooks: ['runbooks/postgres-wal-full.md', 'runbooks/pvc-expand.md'],
  });
}

function makeIncidentB() {
  const g = subgraph();
  const base = incident();
  const incB = {
    ...base,
    incident_id: '00000000-0000-4000-8000-0000000000b2',
    label: 'Deployment:shop/api:2026-11-22T05:30:00Z',
    root: { ...base.root, component: 'Deployment:shop/api' },
    components: ['Deployment:shop/api', 'Deployment:shop/web'],
  };
  return researchCase({
    incident: incB,
    stageA: stageA(stageACards().slice(1)),
    subgraph: { ...g, root: 'Deployment:shop/api' },
    // 故意打乱静态模板与工具的顺序，并附带不同的动态卡片检查与 runbook
    templates: [
      { id: 'workload/restarts', description: '重启查询', args: { type: 'object', properties: {} } },
      {
        id: 'cardcheck:workload/pod-restarts/memory@Deployment:shop/api',
        description: 'B 事件卡片检查',
        args: { type: 'object', properties: {} },
      },
      { id: 'postgres/wal', description: 'WAL 增长查询', args: { type: 'object', properties: {} } },
    ],
    tools: [
      { name: 'kube_events', description: '事件', parameters: { type: 'object', properties: {} } },
      { name: 'kube_pod_status', description: 'Pod 状态', parameters: { type: 'object', properties: {} } },
    ],
    actions: catalogActions(['rollout_pause']),
    runbooks: ['runbooks/api-5xx.md'],
  });
}

function buildStepRequest(
  rc: ReturnType<typeof researchCase>,
  step: 'hypothesize' | 'conclude',
  language: 'zh' | 'en' = 'zh',
): { req: LlmRequest; fullSchema: Record<string, unknown> } {
  const book = incidentBook(rc);
  const parts = promptParts(language, rc, book, 128_000, null);
  const ledger = new Ledger(book, rc.subgraph);
  if (step === 'conclude') {
    ledger.merge(
      [
        {
          id: 'h1',
          parent_id: null,
          root_component: rc.incident.root.component ?? 'Deployment:shop/api',
          mechanism: '数据卷容量接近 100% 导致写入报错',
          supporting: ['card:1'],
          refuting: [],
        },
      ],
      [],
    );
  }
  const bound = bindSchema(modelSchema(step), {
    components: componentChoices(rc),
    evidence_refs: book.refs(),
    sample_refs: book.sampleRefs(),
    check_templates: [...rc.templates.map((t) => t.id), ...rc.tools.map((t) => t.name)],
    runbooks: rc.runbooks,
    actions: rc.actions.map((a) => a.id),
  });
  const items =
    step === 'hypothesize'
      ? hypothesizeItems(language, parts, ledger, book)
      : concludeItems(language, parts, ledger, book);
  return {
    req: { items, output: { name: `${step}_output`, schema: bound.portable }, maxOutputTokens: 4000, temperature: 0 },
    fullSchema: bound.full,
  };
}

describe('P0-1 提示词前缀缓存优化', () => {
  it('两个完全不同的事件在 deepseek / openai-compatible 上生成字节完全一致的 system 消息与静态 catalogSegment', () => {
    const rcA = makeIncidentA();
    const rcB = makeIncidentB();

    for (const language of ['zh', 'en'] as const) {
      const a = buildStepRequest(rcA, 'hypothesize', language);
      const b = buildStepRequest(rcB, 'hypothesize', language);
      for (const profile of [deepseek, openaiCompat]) {
        const chatA = toChatParams(a.req, { model: 'deepseek-chat', profile, language });
        const chatB = toChatParams(b.req, { model: 'deepseek-chat', profile, language });
        expect(chatA.messages[0]).toEqual({ role: 'system', content: PROMPTS[language].system });
        expect(chatA.messages[0]).toEqual(chatB.messages[0]);
        // DeepSeek json_object 模式要求提示词包含字面量 JSON
        expect(String(chatA.messages[0]?.content)).toContain('JSON');
        // schema 说明在任务 user 消息里，不在 system 里
        expect(String(chatA.messages[0]?.content)).not.toContain('```json');
        expect(String(chatA.messages[2]?.content)).toContain(schemaInstruction(a.req.output!.schema, language));
      }
      // Responses 非严格 schema 同样保持 instructions 纯静态
      const respA = toResponsesParams(a.req, { model: 'm', profile: responsesCompat, language });
      const respB = toResponsesParams(b.req, { model: 'm', profile: responsesCompat, language });
      expect(respA.instructions).toBe(PROMPTS[language].system);
      expect(respA.instructions).toBe(respB.instructions);
    }

    // 静态目录段跨事件字节完全一致，不含 cardcheck:、runbook 与按子图过滤的可用动作
    const catA = catalogSegment(rcA).text;
    const catB = catalogSegment(rcB).text;
    expect(catA).toBe(catB);
    expect(catA).not.toContain('cardcheck:');
    expect(catA).not.toContain('runbooks/');
    expect(catA).not.toContain('可用动作（proposals）');
    expect(catA).not.toContain('workload_scale');
    expect(catA).not.toContain('rollout_pause');

    // 动态卡片检查、按子图过滤的可用动作（按 id 排序）与 runbook 落在事件数据段
    const partsA = promptParts('zh', rcA, incidentBook(rcA), 128_000, null);
    const partsB = promptParts('zh', rcB, incidentBook(rcB), 128_000, null);
    const incidentTextA = segmentsText(partsA.incident);
    const incidentTextB = segmentsText(partsB.incident);
    expect(incidentTextA).toContain('cardcheck:pvc/pvc-usage/fill@PersistentVolumeClaim:shop/data-postgres-0');
    expect(incidentTextA).toContain('可用动作（proposals）');
    expect(incidentTextA.indexOf('pod_restart')).toBeGreaterThan(-1);
    expect(incidentTextA.indexOf('workload_scale')).toBeGreaterThan(incidentTextA.indexOf('pod_restart'));
    expect(incidentTextA).toContain('runbooks/postgres-wal-full.md');
    expect(incidentTextB).toContain('rollout_pause');
    expect(incidentTextB).not.toContain('workload_scale');
  });

  it('同一事件的 hypothesize 与 conclude 在 deepseek 上共享字节完全一致的 system 与 user[0]（catalog + incident）前缀', () => {
    const rc = makeIncidentA();
    const hyp = buildStepRequest(rc, 'hypothesize', 'zh');
    const conc = buildStepRequest(rc, 'conclude', 'zh');

    const chatHyp = toChatParams(hyp.req, { model: 'deepseek-chat', profile: deepseek, language: 'zh' });
    const chatConc = toChatParams(conc.req, { model: 'deepseek-chat', profile: deepseek, language: 'zh' });

    expect(chatHyp.messages[0]).toEqual(chatConc.messages[0]);
    expect(chatHyp.messages[1]).toEqual(chatConc.messages[1]);
    // 只有最后一条步骤任务 user 消息随步骤和 schema 变化
    expect(chatHyp.messages[2]).not.toEqual(chatConc.messages[2]);
    expect(String(chatHyp.messages[2]?.content)).toContain('hypothesize');
    expect(String(chatConc.messages[2]?.content)).toContain('conclude');
  });

  it('reask 重试只在首轮消息之后追加 assistant + user，首轮 system 与 user 消息逐字节不变', () => {
    const rc = makeIncidentA();
    const { req } = buildStepRequest(rc, 'hypothesize', 'zh');
    const turn1 = toChatParams(req, { model: 'deepseek-chat', profile: deepseek, language: 'zh' });
    const reaskReq: LlmRequest = {
      ...req,
      items: [
        ...req.items,
        { type: 'assistant', text: '{"hypotheses":[]}' },
        {
          type: 'user',
          segments: [{ text: reaskText('/hypotheses 不能为空', 'zh'), categories: [], egress: 'allow' }],
        },
      ],
    };
    const turn2 = toChatParams(reaskReq, { model: 'deepseek-chat', profile: deepseek, language: 'zh' });

    expect(turn2.messages.slice(0, 3)).toEqual(turn1.messages);
    expect(turn2.messages[3]).toEqual({ role: 'assistant', content: '{"hypotheses":[]}' });
    expect(turn2.messages[4]).toEqual({ role: 'user', content: reaskText('/hypotheses 不能为空', 'zh') });
    // schemaInstruction 仍只出现在首轮任务消息中，不在 reask 末尾重复
    expect(String(turn2.messages[4]?.content)).not.toContain('```json');
  });

  it('repairLocally 仍严格校验动态枚举，非法组件或引用不会绕过拦截', () => {
    const rc = makeIncidentA();
    const { fullSchema } = buildStepRequest(rc, 'hypothesize', 'zh');
    const badTurn: LlmTurn = {
      text: JSON.stringify({
        hypotheses: [
          {
            id: 'h1',
            parent_id: null,
            root_component: 'Deployment:ghost/nonexistent',
            mechanism: '伪造根因',
            mechanism_refs: [],
            supporting: ['card:999'],
            refuting: [],
          },
        ],
        next_checks: [],
      }),
      reasoningChars: 0,
      refusal: null,
      toolCalls: [],
      incomplete: null,
      usage: { input: 100, cachedInput: 80, output: 20, reasoning: 0 },
      responseModel: null,
      systemFingerprint: null,
    };
    const r = repairLocally(badTurn, fullSchema);
    expect(r.ok).toBe(false);
  });
});
