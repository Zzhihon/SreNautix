// 值班页面：收件箱、事件详情、研判运行明细。视图本身在 @srenautix/ui（Grafana 插件共用），
// 这里只负责把过滤条件、标签页放进 URL，以及控制台独有的操作（加入评测用例、原始提示词）。

import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  Button,
  ErrorBox,
  IncidentView,
  InboxView,
  RunView,
  SelectField,
  Sheet,
  TextField,
  useI18n,
  type IncidentTab,
  type InboxFilters,
} from '@srenautix/ui';
import { useState } from 'react';
import { hub, ok } from '../api';
import { useNow } from '../now';
import { hasRole, useSession } from '../session';

export function InboxPage({ cluster, filters }: { cluster?: string; filters: InboxFilters }) {
  const navigate = useNavigate();
  const now = useNow(30_000);
  return (
    <InboxView
      cluster={cluster}
      filters={filters}
      now={now}
      onFilters={(f) => void navigate({ to: '/incidents', search: { cluster, ...f } })}
    />
  );
}

export function IncidentPage({
  incidentRef,
  tab,
  cluster,
}: {
  incidentRef: string;
  tab: IncidentTab;
  cluster?: string;
}) {
  const navigate = useNavigate();
  const now = useNow(15_000);
  return (
    <IncidentView
      incidentRef={incidentRef}
      tab={tab}
      now={now}
      onTab={(next) =>
        void navigate({
          to: '/incidents/$ref',
          params: { ref: incidentRef },
          search: { cluster, tab: next },
          replace: true,
        })
      }
    />
  );
}

function EvalCaseButton({ runId }: { runId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [suite, setSuite] = useState('reference');
  const [type, setType] = useState<'incident' | 'benign' | 'abstain'>('incident');
  const promote = useMutation({
    mutationFn: async () =>
      ok<{ case_id: string; snapshot_status: 'queued' | 'frozen' }>(
        'promoteEvalCase',
        await hub.POST('/v1/runs/{run_id}/eval-case', {
          params: { path: { run_id: runId }, header: { 'X-CSRF-Token': '' } },
          body: { case_type: type, suite },
        }),
      ),
  });
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        {t('run.add_eval_case')}
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={t('run.add_eval_case')}
        description={t('run.add_eval_case_desc')}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            promote.mutate();
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <SelectField
            label={t('run.case_type')}
            value={type}
            onChange={(e) => setType(e.currentTarget.value as typeof type)}
            options={(['incident', 'benign', 'abstain'] as const).map((v) => ({
              value: v,
              label: t(`eval.case_type.${v}`),
            }))}
          />
          <TextField label={t('run.suite')} value={suite} onChange={(e) => setSuite(e.currentTarget.value)} required />
          <Button type="submit" variant="primary" busy={promote.isPending} disabled={!suite.trim()}>
            {t('run.add_eval_case')}
          </Button>
          {promote.data && (
            <p role="status">
              {t('run.case_created', {
                id: promote.data.case_id,
                status: t(`eval.snapshot.${promote.data.snapshot_status}`),
              })}
            </p>
          )}
          {promote.error && <ErrorBox title={t('run.add_eval_case_failed')} error={promote.error} />}
        </form>
      </Sheet>
    </>
  );
}

export function RunPage({ runId }: { runId: string }) {
  const session = useSession();
  const now = useNow(5_000);
  const raw = hasRole(session, 'auditor', 'admin', 'security-admin');
  const write = hasRole(session, 'responder', 'approver', 'admin');
  return (
    <RunView
      runId={runId}
      now={now}
      promptHref={(seq, isRaw) =>
        isRaw ? (raw ? `/runs/${runId}/prompts/raw#call-${seq}` : null) : `/runs/${runId}/prompts#call-${seq}`
      }
      actions={write ? <EvalCaseButton runId={runId} /> : undefined}
    />
  );
}
