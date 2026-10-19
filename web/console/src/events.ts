// 事件流（SSE）驱动缓存失效：服务端每条事件的 SSE id 是游标、event 是事件类型、data 是 OutboxEvent。
// 浏览器的 EventSource 断线后带 Last-Event-ID 自动续传；同一事件可能重复送达，失效操作本身是幂等的。

import type { OutboxEvent } from '@srenautix/contract';
import { invalidationKeys } from '@srenautix/ui';
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
    const es = new EventSource('/v1/events', { withCredentials: true });
    const onEvent = (m: MessageEvent<string>) => {
      const e = JSON.parse(m.data) as OutboxEvent;
      for (const key of invalidationKeys(e)) {
        void qc.invalidateQueries({ queryKey: key });
      }
    };
    for (const t of TYPES) {
      es.addEventListener(t, onEvent);
    }
    es.onopen = () => {
      setState('open');
      // 断线期间可能漏掉事件（服务端从 Last-Event-ID 续传，但游标可能已被截断）：重连后全量对账一次
      void qc.invalidateQueries();
    };
    es.onerror = () => setState('reconnecting');
    return () => es.close();
  }, [qc, enabled]);
  return state;
}
