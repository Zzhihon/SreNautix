import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

/**
 * 测试用的真实 Alertmanager 与 Prometheus（二进制放在 worktree 的 .scratch/bin，
 * 版本见 docs/server/testing.md）。每个实例的数据目录在 .scratch 下，停止时删除。
 */
const ROOT = resolve(import.meta.dirname, '../../../../.scratch');
const BIN = process.env.SRENAUTIX_TEST_BIN ?? join(ROOT, 'bin');

export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? res(a.port) : rej(new Error('取不到空闲端口'))));
    });
  });
}

/**
 * 等到实例就绪，并确认应答的是本测试启动的进程：freePort 释放端口到进程绑定之间，并行的其他测试可能先占用
 * 这个端口，此时本进程绑定失败退出，而 /-/ready 由别的进程应答。进程退出时立即失败并给出 stderr；
 * ownConfig 读取实例加载的配置，必须包含 marker（本实例独有的内容）。
 */
async function waitReady(
  url: string,
  timeoutMs: number,
  proc: { p: ChildProcess; log: () => string },
  ownConfig: { path: string; marker: string },
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (proc.p.exitCode !== null || proc.p.signalCode !== null) {
      throw new Error(`${url} 的进程提前退出\n${proc.log()}`);
    }
    try {
      const r = await fetch(`${url}/-/ready`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) {
        const cfg = await fetch(`${url}${ownConfig.path}`, { signal: AbortSignal.timeout(1000) });
        if (!(await cfg.text()).includes(ownConfig.marker)) {
          throw new Error(`${url} 由其他进程应答（端口被占用）\n${proc.log()}`);
        }
        return;
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('由其他进程应答')) {
        throw e;
      }
      // 尚未监听，继续等待
    }
    if (Date.now() > deadline) {
      throw new Error(`${url} 在 ${timeoutMs} ms 内没有就绪\n${proc.log()}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

export interface Proc {
  url: string;
  /** stderr 的最后 80 行（测试失败时写进错误信息）。 */
  log(): string;
  stop(): Promise<void>;
}

function start(bin: string, args: string[], dir: string): { p: ChildProcess; log: () => string } {
  const path = join(BIN, bin);
  if (!existsSync(path)) {
    throw new Error(`找不到 ${path}；按 docs/server/testing.md 下载`);
  }
  const p = spawn(path, args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
  const lines: string[] = [];
  p.stderr?.setEncoding('utf8');
  p.stderr?.on('data', (chunk: string) => {
    lines.push(...chunk.split('\n').filter(Boolean));
    lines.splice(0, Math.max(0, lines.length - 80));
  });
  return { p, log: () => `${bin}（退出码 ${p.exitCode ?? '运行中'}）stderr：\n${lines.join('\n')}` };
}

function stopper(p: ChildProcess, dir: string): () => Promise<void> {
  return () =>
    new Promise((res) => {
      const done = () => {
        rmSync(dir, { recursive: true, force: true });
        res();
      };
      // 已经退出的进程（例如启动失败）不会再触发 exit
      if (p.exitCode !== null || p.signalCode !== null) {
        done();
        return;
      }
      p.once('exit', done);
      p.kill('SIGTERM');
    });
}

/** Alertmanager（单实例，不组集群）：一个 webhook 接收器，group_wait 1 秒，带 bearer token。 */
export async function startAlertmanager(webhookUrl: string, token: string): Promise<Proc> {
  const port = await freePort();
  const dir = join(ROOT, `am-${process.pid}-${port}`);
  const receiver = `srenautix-${process.pid}-${port}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'am.yml'),
    [
      'route:',
      `  receiver: ${receiver}`,
      '  group_by: [alertname]',
      '  group_wait: 1s',
      '  group_interval: 2s',
      '  repeat_interval: 1h',
      'receivers:',
      `  - name: ${receiver}`,
      '    webhook_configs:',
      `      - url: ${webhookUrl}`,
      '        send_resolved: true',
      '        http_config:',
      '          authorization:',
      '            type: Bearer',
      `            credentials: ${token}`,
      '',
    ].join('\n'),
  );
  const am = start(
    'alertmanager',
    [
      '--config.file=am.yml',
      `--storage.path=${join(dir, 'data')}`,
      `--web.listen-address=127.0.0.1:${port}`,
      // 单实例：关闭 HA 集群。开启集群时 Alertmanager 在 gossip 稳定（settle）之前不发送任何通知，
      // 这段等待随机器快慢变化，会让 webhook 迟到几十秒
      '--cluster.listen-address=',
      // debug 记录收到的告警与每次分组发送，测试超时时据此判断卡在哪一段
      '--log.level=debug',
    ],
    dir,
  );
  const url = `http://127.0.0.1:${port}`;
  const stop = stopper(am.p, dir);
  try {
    // 接收器名只属于本实例（webhook 地址在 /api/v2/status 中显示为 <secret>）
    await waitReady(url, 20_000, am, { path: '/api/v2/status', marker: receiver });
  } catch (e) {
    await stop();
    throw e;
  }
  return { url, log: am.log, stop };
}

/** Prometheus：只有一组告警规则，评估间隔 1 秒，发往给定的 Alertmanager。 */
export async function startPrometheus(rules: string, alertmanagerUrl: string): Promise<Proc> {
  const port = await freePort();
  const dir = join(ROOT, `prom-${process.pid}-${port}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rules.yml'), rules);
  writeFileSync(
    join(dir, 'prom.yml'),
    [
      'global:',
      '  evaluation_interval: 1s',
      '  scrape_interval: 1s',
      'rule_files: [rules.yml]',
      'alerting:',
      '  alertmanagers:',
      '    - static_configs:',
      `        - targets: ['${alertmanagerUrl.replace(/^http:\/\//, '')}']`,
      '',
    ].join('\n'),
  );
  const prom = start(
    'prometheus',
    [
      '--config.file=prom.yml',
      `--storage.tsdb.path=${join(dir, 'data')}`,
      `--web.listen-address=127.0.0.1:${port}`,
      // 通知器应用 Alertmanager 目标之前产生的告警没有发送对象，Prometheus 直接丢弃，之后只在 resend-delay
      // （默认 1 分钟）到期时重发仍在触发的告警。第一次规则评估是否早于目标就绪取决于机器快慢，
      // 设为 1 秒后丢掉的告警在下一秒重发
      '--rules.alert.resend-delay=1s',
      '--log.level=warn',
    ],
    dir,
  );
  const url = `http://127.0.0.1:${port}`;
  const stop = stopper(prom.p, dir);
  try {
    // 本实例的配置里有本测试的 Alertmanager 地址
    await waitReady(url, 30_000, prom, {
      path: '/api/v1/status/config',
      marker: alertmanagerUrl.replace(/^http:\/\//, ''),
    });
  } catch (e) {
    await stop();
    throw e;
  }
  return { url, log: prom.log, stop };
}

export async function until<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
  /** 超时时附在错误信息里的现场（各组件看到的状态、日志）。 */
  diagnose?: () => Promise<string>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) {
      return v;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 ${what} 超时${diagnose ? `\n${await diagnose()}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
