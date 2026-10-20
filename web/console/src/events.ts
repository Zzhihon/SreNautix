// 事件流（SSE）驱动缓存失效：服务端每条事件的 SSE id 是游标、event 是事件类型、data 是 OutboxEvent。
// 浏览器的 EventSource 断线后带 Last-Event-ID 自动续传；同一事件可能重复送达，失效操作本身是幂等的。
// 首次连接不带游标，服务端从当前位置开始推送（不回放历史）。

import type { OutboxEvent } from '@srenautix/contract';
import { createInvalidator, invalidationKeys } from '@srenautix/ui';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

const TYPES: ReadonlyArray<OutboxEvent['type']> = [
  'incident.created',
  'incident.updated',
  'incident.resolved',
  'incident.merged',
  'incident.split',
  'stage_a.reported',
  'research.queued',
  'research.concluded',
  'research.failed',
  'proposal.created',
  'proposal.updated',
  'approval.issued',
  'execution.updated',
  'feedback.recorded',
  'condition.changed',
];

export type StreamState = 'connecting' | 'open' | 'reconnecting';

export function useEventStream(qc: QueryClient, enabled: boolean): StreamState {
  const [state, setState] = useState<StreamState>('connecting');
  useEffect(() => {
    if (!enabled) {
      return;
    }
    // 事件只标记要失效的键，按批合并、节流后统一失效（每个查询同一时刻最多一个请求）
    const inv = createInvalidator(qc);
    const es = new EventSource('/v1/events', { withCredentials: true });
    let opened = false;
    const onEvent = (m: MessageEvent<string>) => {
      inv.keys(invalidationKeys(JSON.parse(m.data) as OutboxEvent));
    };
    for (const t of TYPES) {
      es.addEventListener(t, onEvent);
    }
    es.onopen = () => {
      setState('open');
      // 首次连接时页面的查询刚取过，不需要对账；断线重连后可能漏掉事件（游标可能已被截断），全量对账一次
      if (opened) {
        inv.all();
      }
      opened = true;
    };
    es.onerror = () => setState('reconnecting');
    return () => {
      es.close();
      inv.dispose();
    };
  }, [qc, enabled]);
  return state;
}
