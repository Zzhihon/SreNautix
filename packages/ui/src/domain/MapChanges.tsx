// 地图上的变更列表（ADR 0206）：时间轴选中的一格与组件侧栏共用。摘要来自变更源，是不可信文本，只作为文本显示；
// 链接只接受 http(s)，在新窗口打开。

import type { MapChange } from '../contract';
import { useI18n } from '../i18n';
import { changeGroup } from './cluster-map-model';
import styles from './MapChanges.module.css';

const safeHref = (link: string | null) => (link && /^https?:\/\//i.test(link) ? link : null);

export function MapChangeList({ changes, limit = 5 }: { changes: readonly MapChange[]; limit?: number }) {
  const { t, fmt } = useI18n();
  if (!changes.length) {
    return null;
  }
  const shown = changes.slice(0, limit);
  return (
    <ul className={styles.list}>
      {shown.map((c) => {
        const href = safeHref(c.link);
        return (
          <li key={c.change_id} className={styles.item}>
            <span className={styles.time}>{fmt.clock(c.time)}</span>
            <span className={styles.group} data-group={changeGroup(c.kind)}>
              {t(`map.change_kind.${c.kind}`)}
            </span>
            <span className={styles.summary} title={c.summary}>
              {c.summary}
            </span>
            {c.revision && <code className={styles.rev}>{c.revision.slice(0, 12)}</code>}
            {href && (
              <a className={styles.link} href={href} target="_blank" rel="noopener noreferrer">
                {t('map.change_open')}
              </a>
            )}
          </li>
        );
      })}
      {changes.length > shown.length && (
        <li className={styles.more}>{t('map.change_more', { n: changes.length - shown.length })}</li>
      )}
    </ul>
  );
}
