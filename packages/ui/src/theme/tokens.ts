// 设计令牌。组件的样式只引用 var(--sn-<令牌>)，宿主经 ThemeRoot 注入一套完整的令牌：
// 独立控制台用自带的浅色与深色两套，Grafana 插件用 grafana.ts 从 GrafanaTheme2 映射出来的一套。

export const TOKEN_NAMES = [
  'bg',
  'panel',
  'raise',
  'line',
  'line-soft',
  'text',
  'dim',
  'faint',
  'edge',
  'ok',
  'warn',
  'bad',
  'info',
  'ok-soft',
  'warn-soft',
  'bad-soft',
  'info-soft',
  'focus',
  'hatch',
  'model',
  'model-soft',
  'on-strong',
] as const;

export type Token = (typeof TOKEN_NAMES)[number];

export type ColorScheme = 'light' | 'dark';

export interface DesignTokens {
  scheme: ColorScheme;
  colors: Record<Token, string>;
  fontSans: string;
  fontMono: string;
}

const FONT_SANS =
  '"Inter", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif';
const FONT_MONO = '"JetBrains Mono", "SFMono-Regular", Menlo, Consolas, "PingFang SC", monospace';

// 浅色与深色两套的状态色都与对应背景保持 WCAG AA 对比度（4.5:1 以上）；
// model 是模型生成内容的灰色，与普通正文区分开。
const LIGHT: Record<Token, string> = {
  bg: '#f4f5f7',
  panel: '#ffffff',
  raise: '#eef0f3',
  line: '#d6dbe3',
  'line-soft': '#e7eaef',
  text: '#1a1f28',
  dim: '#525c6c',
  faint: '#707888',
  edge: '#a9b1be',
  ok: '#17703f',
  warn: '#9a5208',
  bad: '#bf2a35',
  info: '#2862b0',
  'ok-soft': '#e1f1e7',
  'warn-soft': '#fbeddb',
  'bad-soft': '#fbe3e4',
  'info-soft': '#e2ecf8',
  focus: '#3854d1',
  hatch: '#c0c7d2',
  model: '#6a7282',
  'model-soft': '#f0f1f4',
  'on-strong': '#ffffff',
};

const DARK: Record<Token, string> = {
  bg: '#111317',
  panel: '#181b20',
  raise: '#20242b',
  line: '#2e333c',
  'line-soft': '#252930',
  text: '#dde1e8',
  dim: '#9aa1af',
  faint: '#737a87',
  edge: '#4c525d',
  ok: '#5fc78c',
  warn: '#eda046',
  bad: '#f26763',
  info: '#64abe3',
  'ok-soft': '#13271c',
  'warn-soft': '#2d200f',
  'bad-soft': '#2d1618',
  'info-soft': '#14243a',
  focus: '#91a8ff',
  hatch: '#3c414a',
  model: '#8b92a0',
  'model-soft': '#1d2026',
  'on-strong': '#111317',
};

export const DEFAULT_TOKENS: Record<ColorScheme, DesignTokens> = {
  light: { scheme: 'light', colors: LIGHT, fontSans: FONT_SANS, fontMono: FONT_MONO },
  dark: { scheme: 'dark', colors: DARK, fontSans: FONT_SANS, fontMono: FONT_MONO },
};

/** `var(--sn-<token>)`，供需要内联样式的少数场景使用（例如图表颜色）。 */
export function tokenVar(t: Token): string {
  return `var(--sn-${t})`;
}

/** 令牌 → CSS 自定义属性。 */
export function cssVariables(t: DesignTokens): Record<string, string> {
  const out: Record<string, string> = { '--sn-font-sans': t.fontSans, '--sn-font-mono': t.fontMono };
  for (const name of TOKEN_NAMES) {
    out[`--sn-${name}`] = t.colors[name];
  }
  return out;
}
