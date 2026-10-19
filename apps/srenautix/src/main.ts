import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { logger } from './log.js';

/**
 * 同一镜像的三个角色与运维子命令：
 *
 *   main.js --role=server|worker|mcp --config=/etc/srenautix/config.yaml [--serve=all|api|console]
 *   main.js db bootstrap|contract --config=…
 *   main.js audit verify --config=…
 *
 * 每个角色的实现是 roles/<role>.js 的 run(argv)；worker 与 mcp 由 hub-worker 维护。
 */
export interface RoleModule {
  run(args: RoleArgs): Promise<void>;
}

export interface RoleArgs {
  configPath: string;
  serve: 'all' | 'api' | 'console';
}

const ROLES = ['server', 'worker', 'mcp'] as const;
type Role = (typeof ROLES)[number];

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      role: { type: 'string' },
      config: { type: 'string', default: '/etc/srenautix/config.yaml' },
      serve: { type: 'string', default: 'all' },
    },
  });
  const configPath = values.config as string;
  if (positionals.length) {
    const { runCommand } = await import('./commands.js');
    await runCommand(positionals, configPath);
    return;
  }
  const role = values.role as Role | undefined;
  if (!role || !(ROLES as readonly string[]).includes(role)) {
    throw new Error(`--role 必须是 ${ROLES.join(' | ')}`);
  }
  const serve = values.serve as RoleArgs['serve'];
  if (!['all', 'api', 'console'].includes(serve)) {
    throw new Error('--serve 必须是 all | api | console');
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, 'roles', `${role}.js`);
  const fileTs = join(here, 'roles', `${role}.ts`);
  if (!existsSync(file) && !existsSync(fileTs)) {
    throw new Error(`角色 ${role} 未构建进本镜像（缺少 roles/${role}.js）`);
  }
  const mod = (await import(`./roles/${role}.js`)) as RoleModule;
  await mod.run({ configPath, serve });
}

main().catch((e: unknown) => {
  logger.error('启动失败', { error: e });
  process.exit(1);
});
