import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerService, type WorkerDeps } from '../../src/research/service.js';
import type { ClaimedTask } from '../../src/research/hub.js';

// 认领循环不能因一次研判的未分类错误退出进程：CCHP gateway 事件的上下文读取超过 30 秒，
// fetch 的 TimeoutError 一路冒到 worker 的循环，未处理的 rejection 让 worker 反复 exit 1。

const task = {
  run_id: 'run-1',
  worker_id: 'w-1',
  incident_id: 'inc-1',
  incident_version: 1,
  reason: 'new_incident',
  lease_expires_at: new Date(Date.now() + 900_000).toISOString(),
} as unknown as ClaimedTask;

/** 认领一次任务后停止循环；context 与 finish 由用例给出 */
function service(context: () => Promise<never>, finish: ReturnType<typeof vi.fn>) {
  const inc = vi.fn();
  const ref: { svc?: WorkerService } = {};
  let claimed = false;
  const d = {
    hub: {
      reportRoutes: vi.fn().mockResolvedValue(undefined),
      claim: vi.fn(async () => {
        if (claimed) {
          ref.svc?.stop();
          return null;
        }
        claimed = true;
        return task;
      }),
      heartbeat: vi.fn().mockResolvedValue(new Date().toISOString()),
      context,
      finish,
    },
    layer: { routes: [], disabled: [], unavailableReason: () => null },
    metrics: { researchRuns: { inc } },
    workerId: 'w-1',
    claimWaitS: 1,
  } as unknown as WorkerDeps;
  ref.svc = new WorkerService(d);
  return { svc: ref.svc, inc };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('worker 认领循环兜住研判任务的错误', () => {
  it('读取上下文超时：循环不抛出，任务记为 failed 并释放租约', async () => {
    vi.useFakeTimers();
    const finish = vi.fn().mockResolvedValue(undefined);
    const { svc, inc } = service(
      () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      finish,
    );
    const done = svc.run(new AbortController().signal);
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBeUndefined();
    expect(finish).toHaveBeenCalledWith('run-1', 'w-1', 'failed');
    expect(inc).toHaveBeenCalledWith({ outcome: 'failed', stop: 'unhandled' });
  });

  it('释放租约本身也失败：仍然不抛出', async () => {
    vi.useFakeTimers();
    const finish = vi.fn().mockRejectedValue(new Error('server 不可达'));
    const { svc } = service(() => Promise.reject(new TypeError('fetch failed')), finish);
    const done = svc.run(new AbortController().signal);
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBeUndefined();
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('外部中止时直接返回，不记为失败', async () => {
    const ctrl = new AbortController();
    const finish = vi.fn().mockResolvedValue(undefined);
    const { svc, inc } = service(() => {
      ctrl.abort(new Error('shutdown'));
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    }, finish);
    await expect(svc.run(ctrl.signal)).resolves.toBeUndefined();
    expect(finish).not.toHaveBeenCalled();
    expect(inc).not.toHaveBeenCalled();
  });
});
