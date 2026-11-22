// 战情室一键「沉淀为知识案例」按钮与确认抽屉：预填事件根因、问题陈述、研判结论或最新反馈，
// 提交至 POST /v1/incidents/{incident_ref}/knowledge（与 P0-2 知识检索闭环对齐）；后端未升级（404/501）时优雅降级。

import { BookmarkCheck, BookmarkPlus } from 'lucide-react';
import { useState } from 'react';
import type { Disposition, Feedback, Incident, ResearchRun } from '../contract';
import { AppLink, usePromoteIncidentKnowledge, useUiEnv } from '../data';
import { useI18n } from '../i18n';
import { ApiError, type LearnedKnowledgeItem } from '../port';
import { Button, ErrorBox, Mono } from '../primitives/basic';
import { SelectField, TextAreaField, TextField } from '../primitives/form';
import { Sheet } from '../primitives/overlays';
import { componentLabel } from './model';
import { useComponentNames } from './names';
import styles from './PromoteCaseButton.module.css';

const BENIGN_REASONS = new Set([
  'false_positive',
  'not_actionable',
  'known_issue',
  'planned_change',
  'transient_self_resolved',
  'external_upstream',
  'duplicate',
]);

export function defaultKnowledgeDraft(args: {
  incident: Incident;
  disposition: Disposition | null;
  rootComponent: string | null;
  run: ResearchRun | null;
  latestFeedback: Feedback | null;
  names?: Readonly<Record<string, string | undefined>> | null;
}): { kind: 'incident' | 'benign'; title: string; text: string; components: string[]; alertnames: string[] } {
  const { incident, disposition, rootComponent, run, latestFeedback, names } = args;
  const isBenign =
    disposition === 'ignore' ||
    latestFeedback?.disposition === 'ignore' ||
    (latestFeedback?.reason_code != null && BENIGN_REASONS.has(latestFeedback.reason_code));
  const kind: 'incident' | 'benign' = isBenign ? 'benign' : 'incident';
  const rootName = rootComponent ? componentLabel(rootComponent, names).name : null;
  const headline = incident.headline?.summary ?? incident.headline?.alertname ?? rootName ?? incident.label;
  const title = (rootName && !headline.includes(rootName) ? `${rootName}：${headline}` : headline).slice(0, 200);

  const leader = run?.output?.hypotheses.find((h) => h.id === run.output?.conclusion.hypothesis_id);
  const textParts = [latestFeedback?.mechanism, latestFeedback?.reason, run?.summary, leader?.mechanism].filter(
    (x): x is string => Boolean(x && x.trim()),
  );
  const text = [...new Set(textParts)].join('；').slice(0, 2000);

  const components = [
    ...new Set([rootComponent, incident.root.component].filter((x): x is string => Boolean(x))),
  ].slice(0, 20);
  const alertnames = [...new Set(incident.members.filter((m) => m.left_version === null).map((m) => m.alertname))]
    .sort()
    .slice(0, 20);
  return { kind, title, text, components, alertnames };
}

export function PromoteCaseButton({
  incidentRef,
  incident,
  disposition,
  rootComponent,
  run,
  latestFeedback,
}: {
  incidentRef: string;
  incident: Incident;
  disposition: Disposition | null;
  rootComponent: string | null;
  run: ResearchRun | null;
  latestFeedback: Feedback | null;
}) {
  const { t } = useI18n();
  const names = useComponentNames();
  const { caps, links, port } = useUiEnv();
  const promote = usePromoteIncidentKnowledge(incidentRef);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<LearnedKnowledgeItem | null>(null);
  const [kind, setKind] = useState<'incident' | 'benign'>('incident');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');

  if (!caps.feedback || !port.actions?.promoteIncidentKnowledge) {
    return null;
  }

  const draft = defaultKnowledgeDraft({ incident, disposition, rootComponent, run, latestFeedback, names });
  const openSheet = () => {
    setKind(draft.kind);
    setTitle(draft.title);
    setText(draft.text);
    promote.reset();
    setOpen(true);
  };

  // 后端未挂载知识沉淀路由时 Fastify 返回 404（code 非 'not_found'）或 501；真实业务 404（事件不存在/无权限，code === 'not_found'）仍按常规报错展示
  const unavailable =
    promote.error instanceof ApiError &&
    (promote.error.status === 501 || (promote.error.status === 404 && promote.error.code !== 'not_found'));

  return (
    <div className={styles.wrap}>
      {saved ? (
        <span className={styles.saved} role="status">
          <BookmarkCheck aria-hidden="true" className={styles.icon} />
          {t('knowledge.promoted_inline')}
          {links.knowledge && (
            <AppLink href={links.knowledge()} className={styles.savedLink}>
              {t('knowledge.view_library')}
            </AppLink>
          )}
        </span>
      ) : (
        <Button size="sm" variant="default" onClick={openSheet}>
          <BookmarkPlus aria-hidden="true" className={styles.icon} />
          {t('knowledge.promote_btn')}
        </Button>
      )}
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={t('knowledge.promote_title')}
        description={t('knowledge.promote_desc')}
      >
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            promote.mutate(
              {
                kind,
                title: title.trim() || undefined,
                text: text.trim() || undefined,
                components: draft.components.length ? draft.components.slice(0, 20) : undefined,
                alertnames: draft.alertnames.length ? draft.alertnames.slice(0, 20) : undefined,
                feedback_id: latestFeedback?.feedback_id ?? null,
              },
              {
                onSuccess: (item) => {
                  setSaved(item);
                  setOpen(false);
                },
              },
            );
          }}
        >
          <SelectField
            label={t('knowledge.field.kind')}
            value={kind}
            onChange={(e) => setKind(e.currentTarget.value as 'incident' | 'benign')}
            options={[
              { value: 'incident', label: t('knowledge.kind.incident') },
              { value: 'benign', label: t('knowledge.kind.benign') },
            ]}
          />
          <TextField
            label={t('knowledge.field.title')}
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.currentTarget.value)}
            required
          />
          <TextAreaField
            label={t('knowledge.field.text')}
            hint={t('knowledge.field.text_hint')}
            value={text}
            maxLength={2000}
            rows={5}
            onChange={(e) => setText(e.currentTarget.value)}
            required
          />
          {(draft.components.length > 0 || draft.alertnames.length > 0) && (
            <div className={styles.metaBox}>
              {draft.components.length > 0 && (
                <div className={styles.metaRow}>
                  <span className={styles.metaLabel}>{t('knowledge.field.components')}</span>
                  {draft.components.map((c) => (
                    <Mono key={c}>{c}</Mono>
                  ))}
                </div>
              )}
              {draft.alertnames.length > 0 && (
                <div className={styles.metaRow}>
                  <span className={styles.metaLabel}>{t('knowledge.field.alerts')}</span>
                  {draft.alertnames.map((a) => (
                    <Mono key={a}>{a}</Mono>
                  ))}
                </div>
              )}
            </div>
          )}
          <Button type="submit" variant="primary" busy={promote.isPending} disabled={!title.trim() || !text.trim()}>
            {t('knowledge.promote_submit')}
          </Button>
          {unavailable ? (
            <p className={styles.unavailable} role="status">
              {t('knowledge.promote_unavailable')}
            </p>
          ) : (
            promote.error && <ErrorBox title={t('knowledge.promote_failed')} error={promote.error} />
          )}
        </form>
      </Sheet>
    </div>
  );
}
