// 组件测试的渲染外壳：设计令牌、文案、TanStack Query 与 UiEnv。端口用真实的 HTTP 实现，
// 指向一个不监听的本地端口；被测组件只渲染传入的数据，不发请求，一旦发请求就以网络错误失败。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Capabilities, Links, UiEnv } from '../data';
import { UiEnvProvider } from '../data';
import { createHubPort } from '../hubPort';
import { I18nProvider, type Locale } from '../i18n';
import { ThemeRoot } from '../theme/ThemeRoot';
import { DEFAULT_TOKENS, type ColorScheme } from '../theme/tokens';

export const LINKS: Links = {
  inbox: () => '/incidents',
  incident: (ref, tab) => `/incidents/${encodeURIComponent(ref)}${tab ? `/${tab}` : ''}`,
  run: (id) => `/runs/${id}`,
  approval: (id) => `/actions/${id}`,
  approvalExternal: false,
};

export const ALL_CAPS: Capabilities = { feedback: true, rerun: true, approve: true, readOnlyReason: '只读' };

export function renderUi(
  node: ReactNode,
  opts: {
    locale?: Locale;
    scheme?: ColorScheme;
    caps?: Partial<Capabilities>;
    links?: Partial<Links>;
    actions?: boolean;
  } = {},
): RenderResult {
  const env: UiEnv = {
    port: createHubPort({ baseUrl: 'http://127.0.0.1:9', csrf: () => null, actions: opts.actions ?? true }),
    links: { ...LINKS, ...opts.links },
    caps: { ...ALL_CAPS, ...opts.caps },
  };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ThemeRoot tokens={DEFAULT_TOKENS[opts.scheme ?? 'light']}>
      <I18nProvider locale={opts.locale ?? 'zh-CN'} timeZone="Asia/Shanghai">
        <QueryClientProvider client={qc}>
          <UiEnvProvider env={env}>{children}</UiEnvProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeRoot>
  );
  return render(node, { wrapper });
}
