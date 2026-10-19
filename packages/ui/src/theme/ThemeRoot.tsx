// 令牌作用域：把一套设计令牌写成 CSS 自定义属性，子树里的组件都从这里取颜色与字体。
// 弹层（Sheet、Tooltip）挂到作用域内的容器上，这样弹层也带着同一套令牌。

import { createContext, useContext, useState, type CSSProperties, type ReactNode } from 'react';
import { cssVariables, type DesignTokens } from './tokens';
import styles from './theme.module.css';

const PortalContext = createContext<HTMLElement | null>(null);

/** 弹层的挂载点；ThemeRoot 尚未挂载完成时为 null（此时 Radix 挂到 body）。 */
export function usePortalContainer(): HTMLElement | null {
  return useContext(PortalContext);
}

export function ThemeRoot({
  tokens,
  className,
  children,
}: {
  tokens: DesignTokens;
  className?: string;
  children: ReactNode;
}) {
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  return (
    <div
      className={className ? `${styles.root} ${className}` : styles.root}
      data-scheme={tokens.scheme}
      style={{ ...cssVariables(tokens), colorScheme: tokens.scheme } as CSSProperties}
    >
      <PortalContext.Provider value={layer}>{children}</PortalContext.Provider>
      <div ref={setLayer} className={styles.layer} />
    </div>
  );
}
