// 基础原语：按钮、面板、键值表、等宽文字、数值块、加载与错误。样式只引用设计令牌。

import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useI18n } from '../i18n';
import type { Tone } from './Status';
import styles from './basic.module.css';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost' | 'link';

export function Button({
  variant = 'default',
  size = 'md',
  busy,
  className,
  children,
  type = 'button',
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  busy?: boolean;
}) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(styles.btn, className)}
      data-variant={variant}
      data-size={size}
    >
      {busy && <Loader2 className={styles.spin} aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Panel({
  title,
  meta,
  actions,
  label,
  id,
  className,
  children,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  /** 读屏用的区域名；有 title 且是纯文字时可省略。 */
  label?: string;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cx(styles.panel, className)}
      aria-label={label ?? (typeof title === 'string' ? title : undefined)}
      id={id}
    >
      {(title || meta || actions) && (
        <header className={styles.panelHead}>
          {title && <h2 className={styles.panelTitle}>{title}</h2>}
          {meta && <span className={styles.meta}>{meta}</span>}
          {actions && <span className={styles.actions}>{actions}</span>}
        </header>
      )}
      {children}
    </section>
  );
}

/** 键值表：审批页、运行明细等按固定顺序展示的字段。 */
export function KeyValue({
  items,
  className,
}: {
  items: ReadonlyArray<{ k: ReactNode; v: ReactNode; id?: string; tone?: Tone }>;
  className?: string;
}) {
  return (
    <dl className={cx(styles.kv, className)}>
      {items.map((it, i) => (
        <div key={it.id ?? i} className={styles.kvRow} data-tone={it.tone} data-testid={it.id}>
          <dt>{it.k}</dt>
          <dd>{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Mono({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <code className={cx(styles.mono, className)} title={title}>
      {children}
    </code>
  );
}

/** 一个数值与它的门槛；超出门槛时用 tone 着色，并且总是写出门槛文字。 */
export function Stat({
  label,
  value,
  threshold,
  tone = 'neutral',
  hint,
}: {
  label: ReactNode;
  value: ReactNode;
  threshold?: ReactNode;
  tone?: Tone;
  hint?: ReactNode;
}) {
  return (
    <div className={styles.stat} data-tone={tone}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{value}</div>
      {threshold && <div className={styles.statThreshold}>{threshold}</div>}
      {hint && <div className={styles.statHint}>{hint}</div>}
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className={styles.loading} role="status" aria-live="polite">
      <Loader2 className={styles.spin} aria-hidden="true" />
      <span>{label ?? t('common.loading')}</span>
    </div>
  );
}

/** 接口或渲染错误：写明是哪个请求、什么错误，不吞掉。 */
export function ErrorBox({ title, error }: { title: ReactNode; error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className={styles.error} role="alert">
      <strong>{title}</strong>
      <span className={styles.errorText}>{message}</span>
    </div>
  );
}

/** 页面标题行：一个页面只回答一个问题，标题就是这个问题。 */
export function PageHeader({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className={styles.pageHead}>
      <h1 className={styles.pageTitle}>{title}</h1>
      {meta && <span className={styles.meta}>{meta}</span>}
      {actions && <span className={styles.actions}>{actions}</span>}
    </header>
  );
}

export function Toolbar({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className={styles.toolbar} role="toolbar" aria-label={label}>
      {children}
    </div>
  );
}
