import type { Incident, Labels } from '@srenautix/contract';
import { incidentCategories, type AlertCatalog } from '@srenautix/core';
import type { Correction } from '../store/corrections.js';

/** 每批补写的事件数 */
const BATCH = 500;

/**
 * 事件层的数据修正（ADR 0176）。
 *
 * incident/categories（ADR 0183）：之前版本写下的事件没有类别，server.incidents 的 categories 与 primary_category 为空。
 * 成员的类别按当前的告警目录与 ingest.category_rules 重算：告警还在 alert_state 时用它的完整标签；已经不在时只按告警名
 * 查目录（命中没有 match_labels 的条目），按标签匹配的规则不生效，求不出时为 unclassified。补写成员的 category、事件 body
 * 的 categories 与 primary_category 和两列；incident_versions 中的历史版本不改。本版本写下的事件两列都不为空，修正只改为空的行
 */
export function incidentCorrections(catalog: AlertCatalog): Correction[] {
  return [
    {
      name: 'incident/categories',
      run: async (c) => {
        let rows = 0;
        for (;;) {
          const batch = await c.query<{ incident_id: string; body: Incident }>(
            'SELECT incident_id, body FROM server.incidents WHERE categories IS NULL ORDER BY incident_id LIMIT $1',
            [BATCH],
          );
          if (!batch.rows.length) {
            return rows;
          }
          const ids = [...new Set(batch.rows.flatMap((r) => r.body.members.map((m) => m.alert_id)))];
          const labels = new Map(
            (
              await c.query<{ alert_id: string; labels: Labels }>(
                'SELECT alert_id, labels FROM server.alert_state WHERE alert_id = ANY($1::text[])',
                [ids],
              )
            ).rows.map((r) => [r.alert_id, r.labels]),
          );
          for (const r of batch.rows) {
            const members = r.body.members.map((m) => ({
              ...m,
              category: m.category ?? catalog.category(labels.get(m.alert_id) ?? { alertname: m.alertname }).category,
            }));
            const cats = incidentCategories(members, r.body.root.component);
            const body: Incident = { ...r.body, members, ...cats };
            await c.query(
              'UPDATE server.incidents SET categories = $2, primary_category = $3, body = $4 WHERE incident_id = $1',
              [r.incident_id, cats.categories, cats.primary_category, JSON.stringify(body)],
            );
            rows++;
          }
        }
      },
    },
  ];
}
