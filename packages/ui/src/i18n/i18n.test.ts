import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import { CONDITION_SEVERITY } from '../domain/ConditionStrip';
import { STATUS } from '../primitives/Status';
import { createI18n, setMissingMessageReporter, UI_MESSAGES, type MissingMessage } from './index';

// 按枚举值拼接的文案键：每个取值在两种语言里都必须存在
const ENUMS: Record<string, readonly string[]> = {
  'approval.decision': ['approved', 'rejected', 'auto'],
  'approval.level': ['reversible', 'reversible_recreatable', 'compensable', 'irreversible'],
  'approval.source': ['research', 'rule', 'human', 'external'],
  'approval.tier': ['L', 'H'],
  'approval.undo': ['auto_restore', 'controller_rebuild', 'compensation', 'none'],
  'detail.rec_kind': ['mitigation', 'root_fix', 'prevention', 'investigation'],
  'detail.risk': ['low', 'medium', 'high'],
  'evidence.egress': ['allow', 'redact', 'never'],
  'evidence.reason': [
    'rule',
    'no_data',
    'partial_data',
    'source_error',
    'capability_missing',
    'observability_gap',
    'evaluation_error',
    'all_clear',
    'model_judged',
  ],
  'hypothesis.consistency': ['entity_in_scope', 'onset_precedes_symptom', 'no_contrary_normal', 'competitor_tested'],
  'inbox.blind': ['ingest_silent', 'observability_blind', 'state_store_degraded'],
  'inbox.empty_none_title': ['firing', 'resolved', 'all'],
  'research.reason': [
    'new_incident',
    'fingerprint_changed',
    'root_changed',
    'severity_raised',
    'feedback',
    'manual',
    'model_recovered',
    'resumed',
    'reopened',
  ],
  'research.state': [
    'queued',
    'hypothesize',
    'discriminate',
    'conclude',
    'completed',
    'stage_a_only',
    'failed',
    'superseded',
  ],
  'run.category': ['metrics', 'logs', 'traces', 'events', 'topology', 'changes', 'alerts', 'knowledge'],
  'run.outcome': ['succeeded', 'retried', 'switched', 'failed'],
  'run.repair': ['parse', 'jsonrepair', 'validate', 'field_salvage', 'reask', 'next_route', 'deterministic_only'],
  'run.stop_reason': ['leader_supported', 'no_change', 'step_limit', 'deadline', 'budget', 'model_unavailable'],
  'subgraph.role': ['root', 'candidate', 'member', 'neighbor'],
  'subgraph.source': ['structural', 'runtime', 'config_ref', 'network_policy', 'naming'],
  'timeline.change_grade': ['high', 'medium', 'low'],
  'timeline.change_basis': [
    'component_match',
    'acts_on',
    'topology_reach',
    'namespace',
    'logical_owner',
    'retire_scrape_job',
    'pending_sync',
    'late',
  ],
  'timeline.kind': [
    'alert_firing',
    'alert_resolved',
    'change',
    'card_abnormal',
    'incident_merged',
    'incident_split',
    'stage_a',
    'research_concluded',
    'proposal',
    'execution',
    'feedback',
  ],
  'verdict.stage_a': [
    'suppressed',
    'pack_exclude',
    'planned_retirement',
    'forecast_or_chronic_only',
    'rule_action',
    'critical_ambiguous',
    'observability_blind',
    'default',
  ],
  condition: Object.keys(CONDITION_SEVERITY),
};

describe('文案', () => {
  it('两种语言的键集合相同', () => {
    expect(Object.keys(UI_MESSAGES.en).sort()).toEqual(Object.keys(UI_MESSAGES['zh-CN']).sort());
  });

  it('每条文案都是合法的 ICU MessageFormat', () => {
    for (const [locale, messages] of Object.entries(UI_MESSAGES)) {
      for (const [id, src] of Object.entries(messages)) {
        expect(() => new IntlMessageFormat(src, locale), `${locale}:${id}`).not.toThrow();
      }
    }
  });

  it('状态表与枚举文案齐全', () => {
    const ids: string[] = [];
    for (const [domain, values] of Object.entries(STATUS)) {
      for (const v of Object.keys(values)) {
        ids.push(`status.${domain}.${v}`);
      }
    }
    for (const [prefix, values] of Object.entries(ENUMS)) {
      for (const v of values) {
        ids.push(`${prefix}.${v}`);
      }
    }
    for (const locale of ['zh-CN', 'en'] as const) {
      const missing = ids.filter((id) => UI_MESSAGES[locale][id] === undefined);
      expect(missing, locale).toEqual([]);
    }
  });

  it('开发与测试环境缺少的键直接报错', () => {
    expect(() => createI18n('zh-CN', 'UTC').t('no.such.key')).toThrow('缺少文案 zh-CN:no.such.key');
  });

  it('生产环境缺少的键不报错：回退到英文文案或键本身，警告并上报一次', () => {
    const reported: MissingMessage[] = [];
    setMissingMessageReporter((m) => reported.push(m));
    const warn = console.warn;
    const warned: unknown[] = [];
    console.warn = (...a: unknown[]) => warned.push(a);
    try {
      const zh = createI18n('zh-CN', 'UTC', { en: { 'only.en': 'Only in English' } }, { strict: false });
      expect(zh.t('no.such.key.prod')).toBe('no.such.key.prod');
      expect(zh.t('no.such.key.prod')).toBe('no.such.key.prod');
      expect(zh.t('only.en')).toBe('Only in English');
      expect(zh.t('condition.QueryManifest')).toBe('查询模板清单未加载');
    } finally {
      console.warn = warn;
      setMissingMessageReporter(() => undefined);
    }
    expect(reported).toEqual([
      { locale: 'zh-CN', id: 'no.such.key.prod', shown: 'no.such.key.prod' },
      { locale: 'zh-CN', id: 'only.en', shown: 'Only in English' },
    ]);
    expect(warned).toHaveLength(2);
  });

  it('时长与时刻按语言和时区格式化', () => {
    const zh = createI18n('zh-CN', 'Asia/Shanghai');
    const en = createI18n('en', 'UTC');
    expect(zh.fmt.duration(45_000)).toBe('45 秒');
    expect(zh.fmt.duration(3 * 3_600_000)).toBe('3 小时');
    expect(zh.fmt.duration(3 * 3_600_000 + 5 * 60_000)).toBe('3 小时 5 分');
    expect(en.fmt.duration(26 * 3_600_000)).toBe('1d 2h');
    const t = Date.parse('2026-10-19T06:05:00Z');
    expect(zh.fmt.clock(t, t)).toBe('14:05');
    expect(zh.fmt.clock(t, t + 86_400_000)).toBe('10-19 14:05');
    expect(en.fmt.dateTime(t)).toBe('2026-10-19 06:05:00');
    expect(zh.t('incident.merged_from', { n: 7 })).toBe('合并自 7');
  });
});
