import type { EvidenceResult } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { remediationContext, remediationRoot, RootCardScope, type RootLookup } from '../../src/remediation/facts.js';
import { incident, stageACards } from '../support/scenario.js';

// 修复模板的 root_cards（ADR 0139）：根因自己的卡

const APP = 'Application.argoproj.io:argocd/shop';
const OWNERS: Record<string, string> = {
  'Pod:shop/api-7d9c-abcde': 'Deployment:shop/api',
  'ReplicaSet:shop/api-7d9c': 'Deployment:shop/api',
  'Pod:shop/web-55f-xyz': 'Deployment:shop/web',
};
const MANAGERS: Record<string, string[]> = {
  'Deployment:shop/api': [APP],
  'Deployment:shop/web': [APP],
};
// 事件组件：逻辑组件 release 与工作负载 api（web 不在事件里）
const INC = { cluster_id: 'test', components: ['component:release', 'Deployment:shop/api', 'Node:node-a'] };

function lookup(calls: string[] = []): Pick<RootLookup, 'owner' | 'managers'> {
  return {
    owner: async (_c, key) => {
      calls.push(key);
      return OWNERS[key] ?? null;
    },
    managers: async (_c, key) => MANAGERS[key] ?? [],
  };
}

function on(cardId: string, key: string, verdict: EvidenceResult['verdict']): EvidenceResult {
  const [kind, rest] = key.split(':') as [string, string];
  const [ns, name] = rest.includes('/') ? (rest.split('/') as [string, string]) : [null, rest];
  return {
    ...stageACards()[0]!,
    card_id: cardId,
    verdict,
    display_state: verdict,
    entity: { cluster_id: 'test', kind, namespace: ns, name: name as string, uid: null },
  };
}

const root = (key: string) => {
  const [kind, rest] = key.split(':') as [string, string];
  const [ns, name] = rest.includes('/') ? (rest.split('/') as [string, string]) : [null, rest];
  return { cluster_id: 'test', kind, namespace: ns, name: name as string, node: null, component_type: null };
};

const CARDS = [
  on('workload/release/init-waiting', 'Pod:shop/api-7d9c-abcde', 'abnormal'),
  on('workload/release/replicasets', 'Deployment:shop/api', 'normal'),
  on('workload/release/init-waiting', 'Pod:shop/web-55f-xyz', 'normal'),
  on('workload/release/replicasets', 'Deployment:shop/web', 'abnormal'),
  on('argocd/app/sync', APP, 'abnormal'),
  on('node/disk/pressure', 'Node:node-a', 'abnormal'),
  { ...stageACards()[0]!, card_id: 'cchp/release/versions', entity: null },
];

describe('模板的根因', () => {
  it('组件类型声明在集群之外时 root.external 为 true（ADR 0139：告警调优模板不对外部上游降级）', async () => {
    const d: RootLookup = {
      ...lookup(),
      concrete: async (_c, key) => {
        const [kind, name] = key.split(':') as [string, string];
        return { key, kind, namespace: null, name, uid: null };
      },
      componentType: async (_c, key) => (key.startsWith('provider:') ? 'demo.provider' : null),
      componentTypes: () => [
        { id: 'demo.provider', external: true, match: { kind: 'provider' } },
        { id: 'demo.node', match: { kind: 'Node' } },
      ],
    };
    const inc = incident();
    expect(await remediationRoot(d, inc, [], 'provider:openai', new Date())).toMatchObject({
      kind: 'provider',
      component_type: 'demo.provider',
      external: true,
    });
    expect(await remediationRoot(d, inc, [], 'Node:node-a', new Date())).toMatchObject({
      component_type: 'demo.node',
      external: false,
    });
  });
});

describe('根因自己的卡', () => {
  it('工作负载根因：它拥有的 Pod 与它自己，加上管理它的应用本身的卡；同一应用管理的其他工作负载不算', async () => {
    const calls: string[] = [];
    const cards = await new RootCardScope(lookup(calls), INC, new Date()).cards(root('Deployment:shop/api'), CARDS);
    expect(cards.map((c) => `${c.card_id}@${c.entity?.name}`)).toEqual([
      'workload/release/init-waiting@api-7d9c-abcde',
      'workload/release/replicasets@api',
      'argocd/app/sync@shop',
    ]);
    // 属主按键缓存：每个键只查一次
    expect(calls.length).toBe(new Set(calls).size);
  });

  it('GitOps 应用根因：它管理的工作负载及其 Pod 都算；节点与没有实体的卡不算', async () => {
    const cards = await new RootCardScope(lookup(), INC, new Date()).cards(root(APP), CARDS);
    expect(cards.map((c) => `${c.card_id}@${c.entity?.name}`)).toEqual([
      'workload/release/init-waiting@api-7d9c-abcde',
      'workload/release/replicasets@api',
      'workload/release/init-waiting@web-55f-xyz',
      'workload/release/replicasets@web',
      'argocd/app/sync@shop',
    ]);
  });

  it('节点根因只有节点自己的卡；没有根因时为空', async () => {
    const scope = new RootCardScope(lookup(), INC, new Date());
    expect((await scope.cards(root('Node:node-a'), CARDS)).map((c) => c.card_id)).toEqual(['node/disk/pressure']);
    expect(await scope.cards(null, CARDS)).toEqual([]);
  });

  it('逻辑组件根因：它自己的卡与事件组件中的工作负载（及其 Pod）的卡', async () => {
    const release = { ...CARDS[0]!, card_id: 'cchp/release/versions', entity: null };
    const onRelease = {
      ...release,
      entity: { cluster_id: 'test', kind: 'component', namespace: null, name: 'release', uid: null },
    };
    const cards = await new RootCardScope(lookup(), INC, new Date()).cards(root('component:release'), [
      ...CARDS,
      onRelease,
    ]);
    expect(cards.map((c) => `${c.card_id}@${c.entity?.name}`)).toEqual([
      'workload/release/init-waiting@api-7d9c-abcde',
      'workload/release/replicasets@api',
      'cchp/release/versions@release',
    ]);
  });

  it('模板上下文：root_cards 与 cards 形状相同，同一张卡取最严重的结论', async () => {
    const r = root('Deployment:shop/web');
    const own = await new RootCardScope(lookup(), INC, new Date()).cards(r, CARDS);
    const ctx = remediationContext(incident(), [], CARDS, r, null, own, new Map());
    expect(ctx.cards['workload/release/init-waiting']?.verdict).toBe('abnormal');
    expect(ctx.root_cards).toEqual({
      'workload/release/init-waiting': {
        verdict: 'normal',
        display_state: 'normal',
        value: '31%',
        reason_kind: 'rule',
      },
      'workload/release/replicasets': {
        verdict: 'abnormal',
        display_state: 'abnormal',
        value: '31%',
        reason_kind: 'rule',
      },
      'argocd/app/sync': { verdict: 'abnormal', display_state: 'abnormal', value: '31%', reason_kind: 'rule' },
    });
  });
});
