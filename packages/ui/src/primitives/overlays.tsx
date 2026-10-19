// 基于 Radix 的交互原语：标签页、侧边抽屉（移动端为底部抽屉）、悬停提示、截断文字、折叠区。

import { ChevronRight, X } from 'lucide-react';
import { Collapsible as RCollapsible, Dialog, Tabs as RTabs, Tooltip } from 'radix-ui';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { usePortalContainer } from '../theme/ThemeRoot';
import styles from './overlays.module.css';

export interface TabDef {
  id: string;
  label: ReactNode;
  /** 标签上的计数或状态。 */
  badge?: ReactNode;
  content: ReactNode;
}

/** 受控标签页；当前标签由宿主保存在 URL 中。 */
export function Tabs({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: readonly TabDef[];
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <RTabs.Root value={value} onValueChange={onChange} className={styles.tabs}>
      <RTabs.List aria-label={label} className={styles.tabList}>
        {tabs.map((t) => (
          <RTabs.Trigger key={t.id} value={t.id} className={styles.tab}>
            {t.label}
            {t.badge !== undefined && <span className={styles.tabBadge}>{t.badge}</span>}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {tabs.map((t) => (
        <RTabs.Content key={t.id} value={t.id} className={styles.tabPanel}>
          {t.content}
        </RTabs.Content>
      ))}
    </RTabs.Root>
  );
}

/** 抽屉：宽屏从右侧滑出，窄屏从底部弹出（审批页移动端优先）。 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  const container = usePortalContainer();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.sheet}>
          <header className={styles.sheetHead}>
            <Dialog.Title className={styles.sheetTitle}>{title}</Dialog.Title>
            <Dialog.Close className={styles.close} aria-label={t('common.close')}>
              <X aria-hidden="true" />
            </Dialog.Close>
          </header>
          {description ? (
            <Dialog.Description className={styles.sheetDesc}>{description}</Dialog.Description>
          ) : (
            <Dialog.Description className={styles.srOnly}>{title}</Dialog.Description>
          )}
          <div className={styles.sheetBody}>{children}</div>
          {footer && <footer className={styles.sheetFoot}>{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** 悬停或键盘聚焦时显示的提示。 */
export function Tip({ text, children }: { text: ReactNode; children: ReactNode }) {
  const container = usePortalContainer();
  return (
    <Tooltip.Provider delayDuration={250}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal container={container}>
          <Tooltip.Content className={styles.tip} sideOffset={6}>
            {text}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

/** 单行截断，悬停提示里显示全文（DESIGN §12.5）。 */
export function Truncate({ text, className }: { text: string; className?: string }) {
  return (
    <Tip text={text}>
      <span className={className ? `${styles.truncate} ${className}` : styles.truncate} tabIndex={0}>
        {text}
      </span>
    </Tip>
  );
}

/** 折叠区；muted 时整体灰色，用于"模型生成，未经验证"的内容。 */
export function Collapsible({
  summary,
  children,
  defaultOpen = false,
  muted,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  muted?: boolean;
}) {
  return (
    <RCollapsible.Root defaultOpen={defaultOpen} className={styles.collapsible} data-muted={muted ? '' : undefined}>
      <RCollapsible.Trigger className={styles.collapsibleTrigger}>
        <ChevronRight className={styles.chevron} aria-hidden="true" />
        {summary}
      </RCollapsible.Trigger>
      <RCollapsible.Content className={styles.collapsibleBody}>{children}</RCollapsible.Content>
    </RCollapsible.Root>
  );
}
