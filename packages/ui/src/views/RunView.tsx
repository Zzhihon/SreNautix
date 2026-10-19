// 研判运行明细页：读取运行与研判清单，交给 RunTrace。页面级操作（加入评测用例、原始提示词入口）
// 由宿主按角色给出。

import type { ReactNode } from 'react';
import { AppLink, useManifest, useRun, useUiEnv } from '../data';
import { RunTrace } from '../domain/RunTrace';
import { useI18n } from '../i18n';
import { ErrorBox, Loading, Mono, PageHeader } from '../primitives/basic';
import styles from './views.module.css';

export function RunView({
  runId,
  now,
  promptHref,
  actions,
}: {
  runId: string;
  now: number;
  promptHref: (seq: number, raw: boolean) => string | null;
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  const { links } = useUiEnv();
  const run = useRun(runId);
  const manifest = useManifest(runId);
  if (run.isPending) {
    return <Loading />;
  }
  if (run.error) {
    return <ErrorBox title={t('run.load_failed')} error={run.error} />;
  }
  return (
    <div className={styles.page}>
      <PageHeader
        title={t('run.title')}
        meta={
          <>
            <Mono>{runId}</Mono> ·{' '}
            <AppLink href={links.incident(run.data.incident_id, 'runs')}>
              {t('run.back_to_incident', { v: run.data.incident_version })}
            </AppLink>
          </>
        }
      />
      {manifest.error && <ErrorBox title={t('run.manifest_failed')} error={manifest.error} />}
      <RunTrace run={run.data} manifest={manifest.data ?? null} now={now} promptHref={promptHref} actions={actions} />
    </div>
  );
}
