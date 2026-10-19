// GrafanaTheme2 → 设计令牌。Grafana 插件在外壳层调用，组件本身不依赖 @grafana/*。

import type { GrafanaTheme2 } from '@grafana/data';
import type { DesignTokens } from './tokens';

export function tokensFromGrafana(theme: GrafanaTheme2): DesignTokens {
  const c = theme.colors;
  return {
    scheme: theme.isDark ? 'dark' : 'light',
    fontSans: theme.typography.fontFamily,
    fontMono: theme.typography.fontFamilyMonospace,
    colors: {
      bg: c.background.canvas,
      panel: c.background.primary,
      raise: c.background.secondary,
      line: c.border.medium,
      'line-soft': c.border.weak,
      text: c.text.primary,
      dim: c.text.secondary,
      faint: c.text.disabled,
      edge: c.border.strong,
      ok: c.success.text,
      warn: c.warning.text,
      bad: c.error.text,
      info: c.info.text,
      'ok-soft': c.success.transparent,
      'warn-soft': c.warning.transparent,
      'bad-soft': c.error.transparent,
      'info-soft': c.info.transparent,
      focus: c.primary.border,
      hatch: c.border.medium,
      model: c.text.secondary,
      'model-soft': c.background.secondary,
      'on-strong': c.primary.contrastText,
    },
  };
}
