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

async function waitReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (r.ok) {
        return;
      }
    } catch {
      // 尚未监听，继续等待
    }
    if (Date.now() > deadline) {
      throw new Error(`${url} 在 ${timeoutMs} ms 内没有就绪`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

export interface Proc {
  url: string;
  stop(): Promise<void>;
}

function start(bin: string, args: string[], dir: string): ChildProcess {
  const path = join(BIN, bin);
  if (!existsSync(path)) {
    throw new Error(`找不到 ${path}；按 docs/server/testing.md 下载`);
  }
  const p = spawn(path, args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
  p.stderr?.resume();
  return p;
}

function stopper(p: ChildProcess, dir: string): () => Promise<void> {
  return () =>
    new Promise((res) => {
      p.once('exit', () => {
        rmSync(dir, { recursive: true, force: true });
        res();
      });
      p.kill('SIGTERM');
    });
}

/** Alertmanager：一个 webhook 接收器，group_wait 1 秒，带 bearer token。 */
export async function startAlertmanager(webhookUrl: string, token: string): Promise<Proc> {
  const port = await freePort();
  const cport = await freePort();
  const dir = join(ROOT, `am-${process.pid}-${port}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'am.yml'),
    [
      'route:',
      '  receiver: srenautix',
      '  group_by: [alertname]',
      '  group_wait: 1s',
      '  group_interval: 2s',
      '  repeat_interval: 1h',
      'receivers:',
      '  - name: srenautix',
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
  const p = start(
    'alertmanager',
    [
      '--config.file=am.yml',
      `--storage.path=${join(dir, 'data')}`,
      `--web.listen-address=127.0.0.1:${port}`,
      `--cluster.listen-address=127.0.0.1:${cport}`,
      '--cluster.advertise-address=127.0.0.1:' + cport,
      '--log.level=warn',
    ],
    dir,
  );
  const url = `http://127.0.0.1:${port}`;
  await waitReady(`${url}/-/ready`, 20_000);
  return { url, stop: stopper(p, dir) };
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
  const p = start(
    'prometheus',
    [
      '--config.file=prom.yml',
      `--storage.tsdb.path=${join(dir, 'data')}`,
      `--web.listen-address=127.0.0.1:${port}`,
      '--log.level=warn',
    ],
    dir,
  );
  const url = `http://127.0.0.1:${port}`;
  await waitReady(`${url}/-/ready`, 30_000);
  return { url, stop: stopper(p, dir) };
}

export async function until<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) {
      return v;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 ${what} 超时`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
