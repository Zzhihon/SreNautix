// 状态的唯一表示方式：图标 + 文字，颜色只是辅助（DESIGN §12.5）。每个领域枚举在 STATUS 表里
// 给出语气和图标，文字取自文案 status.<领域>.<取值>。

import {
  AlertOctagon,
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  CircleDot,
  CircleHelp,
  CircleSlash,
  Clock,
  Combine,
  EyeOff,
  Hourglass,
  Info,
  Loader2,
  type LucideIcon,
  OctagonX,
  PauseCircle,
  PlugZap,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Snowflake,
  Split,
  ThumbsDown,
  ThumbsUp,
  Undo2,
  XCircle,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import styles from './Status.module.css';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral' | 'nodata' | 'model';

export interface StatusDef {
  tone: Tone;
  icon: LucideIcon;
}

const S = (tone: Tone, icon: LucideIcon): StatusDef => ({ tone, icon });

export const STATUS = {
  verdict: {
    abnormal: S('bad', AlertOctagon),
    undeterminable: S('nodata', CircleHelp),
    capability_missing: S('nodata', PlugZap),
    normal: S('ok', CheckCircle2),
  },
  disposition: {
    act: S('bad', Zap),
    escalate: S('warn', AlertTriangle),
    ignore: S('neutral', EyeOff),
    undetermined: S('nodata', CircleHelp),
  },
  conclusion: {
    evidence_consistent: S('ok', ShieldCheck),
    likely: S('info', CircleDot),
    inconclusive: S('nodata', CircleDashed),
    undetermined: S('nodata', CircleHelp),
  },
  severity: {
    critical: S('bad', AlertOctagon),
    warning: S('warn', AlertTriangle),
    info: S('info', Info),
  },
  incident: {
    firing: S('bad', Zap),
    resolved: S('ok', CheckCircle2),
    merged: S('neutral', Combine),
    split: S('neutral', Split),
    suppressed: S('neutral', EyeOff),
    blind: S('nodata', EyeOff),
  },
  hypothesis: {
    supported: S('ok', ThumbsUp),
    refuted: S('neutral', ThumbsDown),
    inconclusive: S('nodata', CircleHelp),
    pending: S('info', Hourglass),
  },
  check: {
    supports: S('ok', ThumbsUp),
    refutes: S('neutral', ThumbsDown),
    inconclusive: S('nodata', CircleHelp),
    failed: S('bad', XCircle),
    not_run: S('nodata', CircleDashed),
  },
  proposal: {
    awaiting_approval: S('warn', Hourglass),
    approved: S('info', ShieldCheck),
    held: S('warn', PauseCircle),
    dispatched: S('info', Loader2),
    rejected_by_policy: S('bad', Ban),
    rejected: S('neutral', XCircle),
    expired: S('nodata', Clock),
    stale: S('nodata', CircleSlash),
    duplicate: S('nodata', Combine),
  },
  execution: {
    pulled: S('info', Loader2),
    prechecked: S('info', Loader2),
    executing: S('info', Loader2),
    verifying: S('info', Loader2),
    verified: S('ok', CheckCircle2),
    failed: S('bad', XCircle),
    verify_failed: S('bad', AlertOctagon),
    reverted: S('warn', Undo2),
    awaiting_compensation_approval: S('warn', RotateCcw),
    needs_human: S('bad', ShieldAlert),
    stale: S('nodata', CircleSlash),
    expired: S('nodata', Clock),
    rejected: S('neutral', XCircle),
    indeterminate: S('bad', CircleHelp),
  },
  research: {
    queued: S('info', Hourglass),
    hypothesize: S('info', Loader2),
    discriminate: S('info', Loader2),
    conclude: S('info', Loader2),
    completed: S('ok', CheckCircle2),
    stage_a_only: S('nodata', CircleSlash),
    failed: S('bad', XCircle),
    superseded: S('nodata', Combine),
  },
  feedback: {
    none: S('nodata', CircleDashed),
    pending: S('info', Hourglass),
    stale: S('warn', RotateCcw),
    given: S('ok', CheckCircle2),
  },
  condition: {
    critical: S('bad', OctagonX),
    warning: S('warn', AlertTriangle),
    ok: S('ok', CheckCircle2),
    frozen: S('bad', Snowflake),
  },
} as const satisfies Record<string, Record<string, StatusDef>>;

export type StatusDomain = keyof typeof STATUS;
export type StatusValue<D extends StatusDomain> = keyof (typeof STATUS)[D] & string;

/** 通用状态标签：图标 + 文字。 */
export function StatusPill({
  tone,
  icon: Icon,
  children,
  title,
  strong,
}: {
  tone: Tone;
  icon: LucideIcon;
  children: ReactNode;
  title?: string;
  /** 实心样式，只用于首屏的主判断。 */
  strong?: boolean;
}) {
  return (
    <span className={styles.pill} data-tone={tone} data-strong={strong ? '' : undefined} title={title}>
      <Icon className={styles.icon} aria-hidden="true" strokeWidth={2.2} />
      <span>{children}</span>
    </span>
  );
}

/** 领域枚举的状态标签：文字取 status.<domain>.<value>，suffix 追加在文字之后。 */
export function Status<D extends StatusDomain>({
  domain,
  value,
  suffix,
  title,
  strong,
}: {
  domain: D;
  value: StatusValue<D>;
  suffix?: ReactNode;
  title?: string;
  strong?: boolean;
}) {
  const { t } = useI18n();
  const table = STATUS[domain] as Record<string, StatusDef>;
  const def = table[value];
  if (!def) {
    throw new Error(`未知状态 ${domain}.${value}`);
  }
  return (
    <StatusPill tone={def.tone} icon={def.icon} title={title} strong={strong}>
      {t(`status.${domain}.${value}`)}
      {suffix}
    </StatusPill>
  );
}

/** 只有图标没有文字的场合（例如密集的时间线标记），用 aria-label 给出文字。 */
export function StatusIcon<D extends StatusDomain>({ domain, value }: { domain: D; value: StatusValue<D> }) {
  const { t } = useI18n();
  const def = (STATUS[domain] as Record<string, StatusDef>)[value];
  if (!def) {
    throw new Error(`未知状态 ${domain}.${value}`);
  }
  const Icon = def.icon;
  const label = t(`status.${domain}.${value}`);
  return (
    <span className={styles.iconOnly} data-tone={def.tone} role="img" aria-label={label} title={label}>
      <Icon className={styles.icon} aria-hidden="true" strokeWidth={2.2} />
    </span>
  );
}
