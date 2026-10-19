import type { TestProject } from 'vitest/node';
import { startCluster } from './pg-cluster.js';

declare module 'vitest' {
  export interface ProvidedContext {
    pgPort: number;
    pgPassword: string;
  }
}

/** 集成测试共用一个 PostgreSQL 实例，每个测试文件各建自己的库。 */
export default async function setup(project: TestProject): Promise<() => void> {
  const c = await startCluster();
  project.provide('pgPort', c.port);
  project.provide('pgPassword', c.password);
  return () => c.stop();
}
