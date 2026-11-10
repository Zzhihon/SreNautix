// 事件的处理人（ADR 0195）：谁在处理、从什么时候开始；有认领权限时可以认领、接手或放下。
// 认领人是主体 id（与反馈、审批相同）；认领与放下都进入事件时间线

import { UserCheck } from 'lucide-react';
import type { IncidentClaim } from '../contract';
import { useClaim, useUiEnv } from '../data';
import { useI18n } from '../i18n';
import { Button } from '../primitives/basic';
import { StatusPill } from '../primitives/Status';
import styles from './VerdictHeader.module.css';

export function ClaimControl({ incidentId, claim }: { incidentId: string; claim: IncidentClaim | null | undefined }) {
  const { t, fmt } = useI18n();
  const { caps } = useUiEnv();
  const m = useClaim(incidentId);
  return (
    <div className={styles.claim}>
      {claim ? (
        <StatusPill tone="info" icon={UserCheck} title={fmt.dateTime(claim.claimed_at)}>
          {t('incident.claimed_by', { who: claim.principal_id })}
        </StatusPill>
      ) : (
        <span className={styles.dim}>{t('claim.none')}</span>
      )}
      {caps.claim && (
        <>
          <Button size="sm" onClick={() => m.mutate(true)} disabled={m.isPending}>
            {claim ? t('claim.take_over') : t('claim.take')}
          </Button>
          {claim && (
            <Button size="sm" variant="link" onClick={() => m.mutate(false)} disabled={m.isPending}>
              {t('claim.release')}
            </Button>
          )}
        </>
      )}
      {m.error && <span className={styles.flag}>{t('claim.failed')}</span>}
    </div>
  );
}
