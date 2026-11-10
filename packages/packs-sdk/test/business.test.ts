import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backendsDir } from '@srenautix/integration-sdk';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PackLintError } from '../src/cel/errors.js';
import { compilePackSet } from '../src/pack/compile.js';
import { loadPackDir } from '../src/pack/load.js';
import { loadBuiltinPacks } from '../src/pack/sources.js';
import { CATALOG, PACKS } from './support.js';
import type { BusinessDomain, ComponentType } from '@srenautix/contract';
import {
  resolveService,
  ServiceCatalog,
  ServiceCatalogError,
  type ServiceInput,
  type TypedObject,
} from '../src/business.js';

const TYPES: ComponentType[] = [
  { id: 'shop.gateway', match: { kind: 'StatefulSet', namespaces: ['shop'], name_pattern: '^gateway$' } },
  { id: 'shop.app', match: { kind: 'component', name_pattern: '^(gateway|orders)$' } },
  { id: 'generic.pdb', match: { kind: 'PodDisruptionBudget' } },
];

const DOMAINS: BusinessDomain[] = [
  {
    id: 'forwarding',
    title: { 'zh-CN': '请求转发', en: 'Forwarding' },
    tier: 'core',
    services: [
      {
        id: 'gateway',
        title: { 'zh-CN': '网关', en: 'Gateway' },
        members: [
          { component_type: 'shop.gateway' },
          // shop.app 同时覆盖网关与订单两个服务的逻辑组件：用比它更具体的 match 区分
          { match: { kind: 'component', name_pattern: '^gateway$' } },
          { match: { kind: 'PodDisruptionBudget', namespaces: ['shop'], name_pattern: '^gateway$' } },
        ],
        namespaces: ['shop'],
      },
    ],
  },
  {
    id: 'orders',
    title: { 'zh-CN': '订单', en: 'Orders' },
    tier: 'core',
    services: [
      {
        id: 'orders-api',
        title: { 'zh-CN': '订单接口', en: 'Orders API' },
        members: [{ component_type: 'shop.app' }, { match: { kind: 'component', name_pattern: '^orders$' } }],
      },
    ],
  },
];

/** 订单在前：验证结果不依赖声明顺序 */
const DOMAINS_ORDERS_FIRST = [DOMAINS[1]!, DOMAINS[0]!];

const services = () => new ServiceCatalog([{ pack: 'shop', domains: DOMAINS }], TYPES);

const obj = (
  kind: string,
  namespace: string | null,
  name: string,
  componentType: string | null = null,
): TypedObject => ({
  kind,
  namespace,
  name,
  componentType,
});

describe('服务目录（ADR 0193）', () => {
  it('对象取最具体的成员；组件类型成员按类型的具体度计', () => {
    const c = services();
    expect(c.ofObject(obj('StatefulSet', 'shop', 'gateway', 'shop.gateway'))).toBe('gateway');
    // 逻辑组件 gateway 的组件类型是 shop.app（订单接口的成员，具体度 1）；网关的 match 同样具体，直接写出的 match 优先
    for (const domains of [DOMAINS, DOMAINS_ORDERS_FIRST]) {
      const cc = new ServiceCatalog([{ pack: 'shop', domains }], TYPES);
      expect(cc.ofObject(obj('component', null, 'gateway', 'shop.app'))).toBe('gateway');
      expect(cc.ofObject(obj('component', null, 'orders', 'shop.app'))).toBe('orders-api');
    }
    // namespaces + name_pattern 比只按 kind 的 generic.pdb 更具体；generic.pdb 不属于任何服务
    expect(c.ofObject(obj('PodDisruptionBudget', 'shop', 'gateway', 'generic.pdb'))).toBe('gateway');
    expect(c.ofObject(obj('PodDisruptionBudget', 'shop', 'redis', 'generic.pdb'))).toBeNull();
    expect(c.ofNamespace('shop')).toBe('gateway');
    expect(c.ofNamespace('kube-system')).toBeNull();
    expect(c.service('orders-api')).toMatchObject({ business_domain: 'orders', tier: 'core', pack: 'shop' });
  });

  it('重复的 id、不存在的组件类型、重复的默认命名空间是声明错误', () => {
    const svc = (id: string, extra: Partial<BusinessDomain['services'][number]> = {}) => ({
      id,
      title: { 'zh-CN': id },
      members: [],
      ...extra,
    });
    const domain = (id: string, s: BusinessDomain['services']): BusinessDomain => ({
      id,
      title: { 'zh-CN': id },
      tier: 'supporting',
      services: s as BusinessDomain['services'],
    });
    const build = (packs: Array<{ pack: string; domains: BusinessDomain[] }>) => () => new ServiceCatalog(packs, TYPES);
    expect(build([{ pack: 'a', domains: [domain('x', [svc('s1')]), domain('x', [svc('s2')])] }])).toThrow(
      /业务领域 x 重复声明/,
    );
    expect(
      build([
        { pack: 'a', domains: [domain('x', [svc('s1')])] },
        { pack: 'b', domains: [domain('y', [svc('s1')])] },
      ]),
    ).toThrow(ServiceCatalogError);
    expect(
      build([{ pack: 'a', domains: [domain('x', [svc('s1', { members: [{ component_type: 'nope' }] })])] }]),
    ).toThrow(/不存在的组件类型 nope/);
    expect(
      build([
        { pack: 'a', domains: [domain('x', [svc('s1', { namespaces: ['n'] }), svc('s2', { namespaces: ['n'] })])] },
      ]),
    ).toThrow(/命名空间 n 已经是服务 s1 的默认命名空间/);
  });
});

describe('一条告警的服务（ADR 0193 §3）', () => {
  const input = (over: Partial<ServiceInput> = {}): ServiceInput => ({
    labels: { alertname: 'X' },
    namespace: null,
    component: () => Promise.resolve(null),
    entity: () => Promise.resolve(null),
    owner: () => Promise.resolve(null),
    ...over,
  });

  it('按 label → catalog → component → entity → owner → namespace 的顺序取第一个给出服务的来源', async () => {
    const c = services();
    const gw = () => Promise.resolve(obj('StatefulSet', 'shop', 'gateway', 'shop.gateway'));
    expect(
      await resolveService(input({ labels: { alertname: 'X', srenautix_service: 'orders-api' }, component: gw }), c),
    ).toEqual({ service: 'orders-api', service_source: 'label', business_domain: 'orders' });
    expect(await resolveService(input({ catalogService: 'orders-api', component: gw }), c)).toMatchObject({
      service: 'orders-api',
      service_source: 'catalog',
    });
    expect(await resolveService(input({ component: gw }), c)).toMatchObject({
      service: 'gateway',
      service_source: 'component',
    });
    expect(await resolveService(input({ entity: gw }), c)).toMatchObject({
      service: 'gateway',
      service_source: 'entity',
    });
    expect(await resolveService(input({ owner: gw }), c)).toMatchObject({
      service: 'gateway',
      service_source: 'owner',
    });
    expect(await resolveService(input({ namespace: 'shop' }), c)).toMatchObject({
      service: 'gateway',
      service_source: 'namespace',
    });
    expect(await resolveService(input({ namespace: 'other' }), c)).toEqual({
      service: null,
      service_source: 'default',
      business_domain: null,
    });
  });

  it('未声明的标签取值被忽略并回调；前面的来源给出服务时不再求后面的对象', async () => {
    const c = services();
    const onInvalidLabel = vi.fn();
    const owner = vi.fn(() => Promise.resolve(obj('StatefulSet', 'shop', 'gateway', 'shop.gateway')));
    const r = await resolveService(
      input({
        labels: { alertname: 'X', srenautix_service: 'typo' },
        catalogService: 'also-unknown',
        component: () => Promise.resolve(obj('component', null, 'orders', 'shop.app')),
        owner,
        onInvalidLabel,
      }),
      c,
    );
    expect(r).toMatchObject({ service: 'orders-api', service_source: 'component' });
    expect(onInvalidLabel).toHaveBeenCalledWith('typo');
    expect(owner).not.toHaveBeenCalled();
  });
});

describe('business.yaml 的编译（ADR 0193 §2）', () => {
  const scratch: string[] = [];
  afterAll(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

  /** 复制 _example，按 edit 改写其中的文件后编译 */
  const compileEdited = async (edit: (pack: string) => void) => {
    const base = join(backendsDir(), 'runs');
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(join(base, 'business-'));
    scratch.push(dir);
    const pack = join(dir, '_example');
    cpSync(join(PACKS, '_example'), pack, { recursive: true });
    edit(pack);
    return compilePackSet([loadPackDir(pack, 'builtin')], { catalog: CATALOG });
  };

  it('示例包的服务目录：组件类型成员与 match 成员都生效', async () => {
    const set = await compilePackSet(loadBuiltinPacks(PACKS, ['_example']), { catalog: CATALOG });
    expect(set.services.service('web')).toMatchObject({
      business_domain: 'storefront',
      tier: 'core',
      pack: '_example',
    });
    expect(
      set.services.ofObject({ kind: 'Deployment', namespace: 'shop', name: 'web', componentType: 'example.web' }),
    ).toBe('web');
    expect(
      set.services.ofObject({ kind: 'PodDisruptionBudget', namespace: 'shop', name: 'web', componentType: null }),
    ).toBe('web');
    expect(set.services.ofNamespace('shop')).toBe('web');
  });

  it('引用不存在的组件类型、告警目录条目引用未声明的服务都是 lint 错误', async () => {
    const replace = (pack: string, file: string, from: string, to: string) => {
      const f = join(pack, file);
      writeFileSync(f, readFileSync(f, 'utf8').replace(from, to));
    };
    for (const [edit, pattern] of [
      [
        (p: string) => replace(p, 'business.yaml', 'component_type: example.web', 'component_type: example.nope'),
        /business\.yaml.*不存在的组件类型 example\.nope/,
      ],
      [
        (p: string) =>
          replace(
            p,
            'alerts.yaml',
            '    category: performance\n',
            '    category: performance\n    service: checkout\n',
          ),
        /alerts\.yaml.*服务 checkout 没有在任何启用的包的 business\.yaml 中声明/,
      ],
    ] as const) {
      const err = await compileEdited(edit).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PackLintError);
      expect((err as Error).message).toMatch(pattern);
    }
  });
});
