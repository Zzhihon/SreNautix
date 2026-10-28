#!/usr/bin/env node
// srenautix pack 命令（lint、lock、test、record、doctor）。apps/srenautix 的 `srenautix pack ...` 调用 runPackCli。

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { assertValid, type PackLock } from '@srenautix/contract';
import {
  detectLabelProfile,
  loadPromqlEngine,
  LokiAdapter,
  PrometheusApiAdapter,
  startPostgres,
  type Dialect,
} from '@srenautix/integration-sdk';
import { parse } from 'yaml';
import { runDoctor } from './doctor.js';
import { loadActionCatalog } from './pack/catalog.js';
import { compilePackSet, type PackSet } from './pack/compile.js';
import { loadLayerFile } from './pack/layers.js';
import type { LoadedPack } from './pack/load.js';
import { loadPackDir } from './pack/load.js';
import { loadBuiltinPacks } from './pack/sources.js';
import { LiveDataSource } from './runtime/datasource.js';
import { ReplayDataSource, writeSnapshot } from './runtime/snapshot.js';
import { loadAlertRules } from './testing/alert-consistency.js';
import { runPackTests } from './testing/pack-test.js';
import { recordSnapshot } from './testing/record.js';
import { replaySnapshot } from './testing/replay.js';

const USAGE = `用法：srenautix pack <命令> [选项]

命令：
  lint     加载并编译领域包（schema、交叉引用、CEL、PromQL 严格解析、动作目录），输出 pack.lock 摘要
  lock     计算 pack.lock；--write 写入文件，--check 与已有文件比对
  test     在 Prometheus 与 VictoriaMetrics 上执行夹具与自动测试；--replay 改为在 tests/replay/*.json 快照上执行；
           --test <包名> 只执行这些包的测试（其余包仍然加载，供跨包引用的证据链编译），可重复；
           --alert-rules <文件> 告警规则文件（Prometheus 规则、PrometheusRule 或 VMRule），可重复：
           告警目录条目的主卡的夹具测试同时求告警规则，告警在卡片窗口内触发与主卡判为异常必须一致；
           --postgres <二进制目录> 启动一个预加载 pg_stat_statements 的 PostgreSQL，带 input_sql 的夹具另在它上面执行
  record   在真实数据源上执行卡片并录制查询邻域快照
  doctor   覆盖情况：已解析的信号、14 天内未映射的告警名、没有证据链的组件

通用选项：
  --packs <目录>       内置包目录（默认 ./packs）
  --pack <目录>        额外加载的包目录，可重复
  --only <包名>        只加载这些内置包，可重复
  --layer <文件>       用户层文件，按出现顺序合并，可重复
  --catalog <文件>     动作目录（默认 ./contract/gateway/v1/action-catalog.yaml）
  --lock <文件>        已提交的 pack.lock，加载结果必须一致
数据源选项（record、doctor）：
  --prometheus <URL>   Prometheus API 地址
  --dialect <promql|metricsql>  （VictoriaMetrics 可同时接受两种，默认 promql）
  --loki <URL>         Loki 地址（日志卡）
  --cluster-label <名> 外部标签 cluster 的名字
  --at <RFC3339>       评估时刻（默认当前时间）
record 选项：
  --card <键>          <pack>/<chain>/<card>，可重复
  --entity <描述>      <kind>/<namespace>/<name>，命名空间可空，与 --card 一一对应
  --anchor <RFC3339>   事件锚点
  --out <文件>         快照输出路径
`;

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

async function loadSet(v: Record<string, unknown>): Promise<PackSet> {
  const packsDir = resolve(String(v['packs'] ?? 'packs'));
  const only = (v['only'] as string[] | undefined) ?? undefined;
  const packs: LoadedPack[] = existsSync(packsDir) ? loadBuiltinPacks(packsDir, only) : [];
  for (const d of (v['pack'] as string[] | undefined) ?? []) {
    packs.push(loadPackDir(resolve(d), `dir:${resolve(d)}`));
  }
  if (!packs.length) {
    throw new Error(`没有加载到任何领域包（--packs ${packsDir}）`);
  }
  const layers = ((v['layer'] as string[] | undefined) ?? []).map((f) => loadLayerFile(resolve(f)));
  const catalog = loadActionCatalog(resolve(String(v['catalog'] ?? 'contract/gateway/v1/action-catalog.yaml')));
  const lockFile = v['lock'] as string | undefined;
  const expectedLock = lockFile
    ? assertValid<PackLock>('schemas/pack.schema.json#/$defs/PackLock', parse(readFileSync(lockFile, 'utf8')))
    : undefined;
  return compilePackSet(packs, { layers, catalog, ...(expectedLock ? { expectedLock } : {}) });
}

async function liveSource(v: Record<string, unknown>, at: string) {
  const url = v['prometheus'] as string | undefined;
  if (!url) {
    throw new Error('需要 --prometheus');
  }
  const dialect = (v['dialect'] as Dialect | undefined) ?? 'promql';
  const adapter = new PrometheusApiAdapter({
    id: 'metrics',
    url,
    dialects: dialect === 'metricsql' ? ['promql', 'metricsql'] : ['promql'],
  });
  const clock = { from: new Date(Date.parse(at) - 30 * 86_400_000).toISOString(), to: at };
  const profile = await detectLabelProfile(adapter, at, clock, {
    cluster_label: (v['cluster-label'] as string | undefined) ?? null,
  });
  const lokiUrl = v['loki'] as string | undefined;
  const logsProfile = { namespace: 'namespace', pod: 'pod', container: 'container', cluster: profile.cluster };
  return new LiveDataSource({
    metrics: { adapter, profile },
    ...(lokiUrl
      ? { logs: { adapter: new LokiAdapter({ id: 'logs', url: lokiUrl, labels: logsProfile }), profile: logsProfile } }
      : {}),
  });
}

export async function runPackCli(
  argv: string[],
  io: Io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    io.out(USAGE);
    return cmd ? 0 : 2;
  }
  const { values: v } = parseArgs({
    args: rest,
    options: {
      packs: { type: 'string' },
      pack: { type: 'string', multiple: true },
      only: { type: 'string', multiple: true },
      test: { type: 'string', multiple: true },
      layer: { type: 'string', multiple: true },
      catalog: { type: 'string' },
      lock: { type: 'string' },
      write: { type: 'string' },
      check: { type: 'string' },
      replay: { type: 'boolean' },
      prometheus: { type: 'string' },
      dialect: { type: 'string' },
      loki: { type: 'string' },
      'cluster-label': { type: 'string' },
      at: { type: 'string' },
      card: { type: 'string', multiple: true },
      entity: { type: 'string', multiple: true },
      anchor: { type: 'string' },
      out: { type: 'string' },
      json: { type: 'boolean' },
      'alert-rules': { type: 'string', multiple: true },
      postgres: { type: 'string' },
    },
    strict: true,
  });

  switch (cmd) {
    case 'lint': {
      const set = await loadSet(v);
      io.out(
        `${set.packs.length} 个包、${set.cards.size} 张卡、${set.signals.size} 个信号、${set.rules.length} 条规则提议\n`,
      );
      for (const d of set.disabled) {
        io.out(`禁用 ${d.name}：${d.reason}\n`);
      }
      io.out(`pack.lock ${set.lockDigest}\n`);
      return 0;
    }
    case 'lock': {
      const set = await loadSet(v);
      const text = JSON.stringify(set.lock, null, 2) + '\n';
      if (v.check) {
        const existing = JSON.stringify(JSON.parse(readFileSync(v.check, 'utf8')), null, 2) + '\n';
        if (existing !== text) {
          io.err(`${v.check} 与加载结果不一致，执行 srenautix pack lock --write ${v.check} 更新\n`);
          return 1;
        }
        io.out(`${v.check} 一致\n`);
        return 0;
      }
      if (v.write) {
        writeFileSync(v.write, text);
        io.out(`已写入 ${v.write}\n`);
      } else {
        io.out(text);
      }
      return 0;
    }
    case 'test': {
      const set = await loadSet(v);
      const tested = v.test as string[] | undefined;
      for (const n of tested ?? []) {
        if (!set.packs.some((p) => p.name === n)) {
          throw new Error(`--test 指定的包 ${n} 没有加载`);
        }
      }
      if (v.replay) {
        let failed = 0;
        let files = 0;
        for (const p of set.packs.filter((x) => !tested || tested.includes(x.name))) {
          const dir = join(p.dir, 'tests', 'replay');
          if (!existsSync(dir)) {
            continue;
          }
          for (const f of readdirSync(dir)
            .filter((n) => n.endsWith('.json'))
            .sort()) {
            files++;
            const report = await replaySnapshot(set, ReplayDataSource.fromFile(join(dir, f)).snap);
            for (const c of report.cases) {
              io.out(
                `${c.passed ? '通过' : '失败'}  ${p.name}/tests/replay/${f}  ${c.card}  ${c.entity}  ${c.verdict}${c.expected ? `（期望 ${c.expected}）` : ''}  ${c.reason}\n`,
              );
              failed += c.passed ? 0 : 1;
            }
            io.out(`快照未命中率 ${(report.miss_rate * 100).toFixed(1)}%\n`);
          }
        }
        if (!files) {
          io.err('没有找到 tests/replay/*.json 快照\n');
          return 1;
        }
        return failed ? 1 : 0;
      }
      const rules = v['alert-rules'] as string[] | undefined;
      const pgBin = v.postgres as string | undefined;
      const postgres = pgBin ? await startPostgres(resolve(pgBin)) : null;
      let report;
      try {
        report = await runPackTests({
          set,
          ...(tested ? { packs: tested } : {}),
          ...(rules ? { alertRules: loadAlertRules(rules, await loadPromqlEngine()) } : {}),
          ...(postgres ? { postgres } : {}),
        });
      } finally {
        await postgres?.stop();
      }
      if (v.json) {
        io.out(JSON.stringify(report, null, 2) + '\n');
      } else {
        for (const c of report.cases.filter((x) => !x.passed)) {
          io.out(`失败  ${c.card}  ${c.name}  ${c.failure}\n`);
        }
        for (const p of report.packs) {
          io.out(
            `${p.passed ? '通过' : '失败'}  ${p.name}（${p.maturity}）${p.uncovered.length ? `  缺少测试：${p.uncovered.join('、')}` : ''}${p.skipped?.length ? `  没有 --postgres，跳过：${p.skipped.join('、')}` : ''}\n`,
          );
        }
        io.out(`${report.cases.filter((c) => c.passed).length}/${report.cases.length} 个用例通过\n`);
        if (rules) {
          io.out(`主卡与告警规则的一致性核对 ${report.alert_checks} 次\n`);
        }
      }
      return report.passed ? 0 : 1;
    }
    case 'record': {
      const set = await loadSet(v);
      const at = v.at ?? new Date().toISOString();
      const cards = v.card ?? [];
      const entities = v.entity ?? [];
      if (!cards.length || cards.length !== entities.length || !v.anchor || !v.out) {
        throw new Error('record 需要成对的 --card 与 --entity，以及 --anchor、--out');
      }
      const ds = await liveSource(v, at);
      const snap = await recordSnapshot(
        set,
        ds,
        cards.map((card, i) => {
          const [kind, namespace, name] = entities[i]!.split('/');
          if (!kind || name === undefined) {
            throw new Error(`--entity 格式为 <kind>/<namespace>/<name>：${entities[i]}`);
          }
          return {
            card,
            entity: { cluster_id: 'recorded', kind, namespace: namespace || null, name },
            anchor: v.anchor!,
          };
        }),
      );
      writeSnapshot(v.out, snap);
      io.out(`已写入 ${v.out}：${snap.entries.length} 个请求、${snap.cases.length} 个用例\n`);
      return 0;
    }
    case 'doctor': {
      const set = await loadSet(v);
      const at = v.at ?? new Date().toISOString();
      const report = await runDoctor(set, await liveSource(v, at), at);
      if (v.json) {
        io.out(JSON.stringify(report, null, 2) + '\n');
        return 0;
      }
      const resolved = report.signals.filter((s) => s.selected !== null).length;
      io.out(`信号：${resolved}/${report.signals.length} 已解析\n`);
      for (const s of report.signals.filter((x) => x.selected === null)) {
        io.out(`  未解析 ${s.signal}：${s.rejected.map((r) => `备选 ${r.index} ${r.reason}`).join('；')}\n`);
      }
      io.out(`14 天内未映射的告警名：${report.unmapped_alerts.length}\n`);
      for (const a of report.unmapped_alerts) {
        io.out(`  ${a.alertname}（${a.firing_series} 条序列）\n`);
      }
      io.out(`没有证据链的组件类型：${report.components_without_chains.length}\n`);
      for (const c of report.components_without_chains) {
        io.out(`  ${c}\n`);
      }
      io.out(`没有证据链的告警目录条目：${report.catalog_entries_without_chains.length}\n`);
      for (const s of report.suggestions) {
        io.out(`建议：${s}\n`);
      }
      return 0;
    }
    default:
      io.err(`未知命令 ${cmd}\n${USAGE}`);
      return 2;
  }
}

// 作为 bin 直接执行时（pnpm 安装的 bin 是符号链接，比较解析后的真实路径）
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runPackCli(process.argv.slice(2));
}
