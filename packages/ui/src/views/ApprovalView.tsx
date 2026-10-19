// 审批页：读取提议详情交给 ApprovalSheet。重新认证与通行密钥由宿主（控制台）注入。

import { useProposal } from '../data';
import { ApprovalSheet, type PasskeyHook, type ReauthHook } from '../domain/ApprovalSheet';
import { useI18n } from '../i18n';
import { ErrorBox, Loading, Mono, PageHeader } from '../primitives/basic';
import styles from './views.module.css';

export function ApprovalView({
  proposalId,
  reauth,
  passkey,
  now,
}: {
  proposalId: string;
  reauth: ReauthHook;
  passkey: PasskeyHook | null;
  now: number;
}) {
  const { t } = useI18n();
  const q = useProposal(proposalId);
  if (q.isPending) {
    return <Loading />;
  }
  if (q.error) {
    return <ErrorBox title={t('approval.load_failed')} error={q.error} />;
  }
  return (
    <div className={styles.page}>
      <PageHeader
        title={t('approval.title', { action: q.data.proposal.action, target: q.data.proposal.target.display })}
        meta={<Mono>{proposalId}</Mono>}
      />
      <ApprovalSheet detail={q.data} reauth={reauth} passkey={passkey} now={now} />
    </div>
  );
}
