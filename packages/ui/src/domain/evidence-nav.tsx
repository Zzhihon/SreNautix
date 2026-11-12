// 证据引用（card:3）在页面各处的同一种写法：能查到卡时显示判定、标题与主值，点击后打开证据标签页里的这张卡；
// 查不到时（告警、变更的引用，或没有提供导航）只显示引用本身。

import { createContext, useContext, type ReactNode } from 'react';
import type { EvidenceResult } from '../contract';
import { localizedText, useI18n } from '../i18n';
import { Mono } from '../primitives/basic';
import { StatusIcon } from '../primitives/Status';
import styles from './evidence-nav.module.css';

/**
 * 页内锚点：card:3 → card-3。通知与 issue 中证据卡的链接是 /incidents/<id>?tab=evidence#card-<n>（ADR 0125）。
 */
export function evidenceAnchor(ref: string): string {
  return ref.replace(':', '-');
}

export function evidenceTitle(r: EvidenceResult, locale: string): string {
  return localizedText(r.title as Record<string, string | undefined>, locale) || r.card_id;
}

export interface EvidenceNav {
  card: (ref: string) => EvidenceResult | undefined;
  /** 展开这张卡并滚动到它；卡不在当前标签页时先切换到证据标签页。 */
  open: (ref: string) => void;
}

const NavContext = createContext<EvidenceNav | null>(null);

export function EvidenceNavProvider({ nav, children }: { nav: EvidenceNav; children: ReactNode }) {
  return <NavContext.Provider value={nav}>{children}</NavContext.Provider>;
}

export function EvidenceRefChip({ refId }: { refId: string }) {
  const { locale } = useI18n();
  const nav = useContext(NavContext);
  const r = nav?.card(refId);
  if (!nav || !r) {
    return refId.startsWith('card:') ? (
      <a href={`#${evidenceAnchor(refId)}`} className={styles.plain}>
        {refId}
      </a>
    ) : (
      <span className={styles.plain}>{refId}</span>
    );
  }
  return (
    <button type="button" className={styles.chip} data-state={r.display_state} onClick={() => nav.open(refId)}>
      <StatusIcon domain="verdict" value={r.display_state} />
      <span className={styles.chipTitle}>{evidenceTitle(r, locale)}</span>
      {r.value !== null && <span className={styles.chipValue}>{r.value}</span>}
      <Mono className={styles.chipRef}>{refId}</Mono>
    </button>
  );
}
