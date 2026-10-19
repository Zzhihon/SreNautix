// 插件 e2e 的真实环境：控制台 e2e 的同一套后端（PostgreSQL、envtest、server 角色提供接口与控制台、OIDC 身份源与种子数据），
// 加上一个真实的 Grafana（官方发行包，版本取 GRAFANA_VERSION，解压在 .scratch/grafana），插件目录指向本包的 dist，
// 插件配置经 Grafana 的 provisioning 写入（中心地址、控制台地址、Grafana 插件 token）。

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { REPO, startHub, TOKENS, type HubState } from '../../../web/console/e2e/hub.ts';

export const PLUGIN_ID = 'srenautix-console-app';
export const GRAFANA_HOME = process.env.SRENAUTIX_GRAFANA_HOME ?? join(REPO, '.scratch', 'grafana');
export const SCRATCH = join(REPO, '.scratch', 'grafana-e2e');
export const STATE_FILE = join(SCRATCH, 'state.json');
export const GRAFANA_ADMIN = { user: 'admin', password: 'grafana-e2e-password', email: 'oncall@example.com' };
export const OIDC_USER = {
  sub: 'oncall-1',
  preferred_username: 'oncall',
  email: GRAFANA_ADMIN.email,
  groups: ['sre'],
  union_id: 'u-oncall-1',
};

export interface GrafanaState {
  grafanaUrl: string;
  hub: HubState;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? res(a.port) : rej(new Error('取不到空闲端口'))));
    });
  });
}

export async function startGrafanaStack(): Promise<{ state: GrafanaState; stop: () => Promise<void> }> {
  const bin = join(GRAFANA_HOME, 'bin', 'grafana');
  if (!existsSync(bin)) {
    throw new Error(`找不到 Grafana：${bin}（把官方发行包解压到 ${GRAFANA_HOME}，或用 SRENAUTIX_GRAFANA_HOME 指定）`);
  }
  const dist = resolve(import.meta.dirname, '..', 'dist');
  if (!existsSync(join(dist, 'module.js')) || !existsSync(join(dist, 'plugin.json'))) {
    throw new Error(`插件没有构建：${dist}（先执行 pnpm --filter @srenautix/grafana-app build）`);
  }
  // Grafana 管理员的邮箱对应一个 OIDC 用户；server 把插件请求里的邮箱映射到登录过控制台的用户
  const hub = await startHub({
    oidc: {
      accounts: [OIDC_USER],
      bindings: [
        { subject: { kind: 'group', name: 'sre' }, role: 'responder', scope: { clusters: ['*'], namespaces: ['*'] } },
      ],
    },
  });
  let grafana: ChildProcess | null = null;
  const stop = async () => {
    if (grafana && grafana.exitCode === null) {
      const g = grafana;
      await new Promise<void>((res) => {
        g.once('exit', () => res());
        g.kill('SIGTERM');
      });
    }
    await hub.stop();
  };
  try {
    rmSync(SCRATCH, { recursive: true, force: true });
    const plugins = join(SCRATCH, 'plugins');
    const provisioning = join(SCRATCH, 'provisioning');
    mkdirSync(plugins, { recursive: true });
    for (const d of ['plugins', 'datasources', 'dashboards', 'alerting', 'notifiers', 'access-control']) {
      mkdirSync(join(provisioning, d), { recursive: true });
    }
    symlinkSync(dist, join(plugins, PLUGIN_ID));
    writeFileSync(
      join(provisioning, 'plugins', 'srenautix.yaml'),
      stringify({
        apiVersion: 1,
        apps: [
          {
            type: PLUGIN_ID,
            org_id: 1,
            disabled: false,
            jsonData: { hubUrl: hub.state.apiUrl, consoleUrl: hub.state.consoleUrl },
            secureJsonData: { hubToken: TOKENS.grafana },
          },
        ],
      }),
    );
    const port = await freePort();
    const log = join(SCRATCH, 'grafana.log');
    writeFileSync(log, '');
    grafana = spawn(bin, ['server', `--homepath=${GRAFANA_HOME}`], {
      env: {
        ...process.env,
        GF_SERVER_HTTP_ADDR: '127.0.0.1',
        GF_SERVER_HTTP_PORT: String(port),
        GF_PATHS_DATA: join(SCRATCH, 'data'),
        GF_PATHS_LOGS: join(SCRATCH, 'logs'),
        GF_PATHS_PLUGINS: plugins,
        GF_PATHS_PROVISIONING: provisioning,
        GF_SECURITY_ADMIN_USER: GRAFANA_ADMIN.user,
        GF_SECURITY_ADMIN_PASSWORD: GRAFANA_ADMIN.password,
        GF_SECURITY_ADMIN_EMAIL: GRAFANA_ADMIN.email,
        GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS: PLUGIN_ID,
        GF_ANALYTICS_REPORTING_ENABLED: 'false',
        GF_ANALYTICS_CHECK_FOR_UPDATES: 'false',
        GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: 'false',
        GF_NEWS_NEWS_FEED_ENABLED: 'false',
        GF_LOG_MODE: 'console',
        GF_LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const append = (b: Buffer) => writeFileSync(log, b, { flag: 'a' });
    grafana.stdout?.on('data', append);
    grafana.stderr?.on('data', append);
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          break;
        }
      } catch {
        // 尚未监听
      }
      if (grafana.exitCode !== null) {
        throw new Error(`Grafana 启动失败，见 ${log}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`Grafana 在 120 秒内没有就绪，见 ${log}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const state: GrafanaState = { grafanaUrl: url, hub: hub.state };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return { state, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}
