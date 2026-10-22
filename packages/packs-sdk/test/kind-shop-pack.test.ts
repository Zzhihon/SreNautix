import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compilePackSet } from '../src/pack/compile.js';
import { loadPackDir } from '../src/pack/load.js';
import { loadBuiltinPacks } from '../src/pack/sources.js';
import { runPackTests } from '../src/testing/pack-test.js';
import { CATALOG, PACKS, REPO } from './support.js';

// Kind 的用户领域包 kind-shop（deploy/kind/gitops/srenautix/packs/kind-shop）与内置包一起编译，它自己的卡
// （外部客户端请求失败比例，shop 唯一的影响卡，ADR 0139）在 Prometheus 与 VictoriaMetrics 上通过夹具
describe('kind-shop 包', () => {
  it('与内置包一起编译，影响卡只挂在客户端请求路径上的 web 与 api，夹具与自动测试全部通过', async () => {
    const dir = join(REPO, 'deploy/kind/gitops/srenautix/packs/kind-shop');
    const set = await compilePackSet([...loadBuiltinPacks(PACKS), loadPackDir(dir, 'kind')], { catalog: CATALOG });
    expect(set.disabled).toEqual([]);
    expect(set.cards.get('kind-shop/traffic/client-errors')?.def.impact).toBe(true);
    const types = set.packs.find((p) => p.name === 'kind-shop')!.content.components.component_types;
    const withTraffic = types.filter((t) => (t.chains ?? []).includes('traffic')).map((t) => t.id);
    expect(withTraffic.sort()).toEqual(['shop.api', 'shop.web']);

    const report = await runPackTests({ set, packs: ['kind-shop'] });
    expect(report.cases.filter((c) => !c.passed)).toEqual([]);
    const fixtures = report.cases.filter((c) => c.kind === 'fixture');
    expect(
      fixtures.map((c) => [c.name, c.results.prometheus?.verdict, c.results['victoria-metrics']?.verdict]),
    ).toEqual([
      ['请求全部成功：api 的一次容器重启没有影响用户', 'normal', 'normal'],
      ['web 上同样正常', 'normal', 'normal'],
      ['约三分之一的请求失败', 'abnormal', 'abnormal'],
      ['checkout 不在客户端的请求路径上，没有数据', 'undeterminable', 'undeterminable'],
    ]);
    expect(report.packs).toEqual([{ name: 'kind-shop', maturity: 'stable', uncovered: [], passed: true }]);
  });
});
