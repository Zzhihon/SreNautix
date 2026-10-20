import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import {
  DEFAULT_TOKENS,
  I18nProvider,
  setMissingMessageReporter,
  setRenderErrorReporter,
  ThemeRoot,
} from '@srenautix/ui';
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { fetchSession } from './api';
import { CONSOLE_MESSAGES } from './messages';
import { usePrefs, useScheme } from './prefs';
import { makeRouter } from './router';
import './global.css';

// 缺少文案与组件渲染出错：生产环境不让页面崩溃（显示英文或键本身、局部降级），在浏览器控制台记录一次。
// 控制台目前没有前端错误收集接口；接入后在这里改为上报
setMissingMessageReporter((m) => console.warn('srenautix.console.missing_message', m));
setRenderErrorReporter((e) => console.warn('srenautix.console.render_error', e.area));

// 服务端对每个事件推送失效；另外每 60 秒全量对账一次（DESIGN §2.3）
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, refetchInterval: 60_000, retry: 1 } },
});
const router = makeRouter({ queryClient, session: fetchSession });

function Root() {
  const prefs = usePrefs();
  const scheme = useScheme(prefs.theme);
  useEffect(() => {
    document.documentElement.lang = prefs.locale;
    document.documentElement.style.colorScheme = scheme;
    document.body.style.background = DEFAULT_TOKENS[scheme].colors.bg;
  }, [prefs.locale, scheme]);
  return (
    <ThemeRoot tokens={DEFAULT_TOKENS[scheme]}>
      <I18nProvider locale={prefs.locale} timeZone={prefs.timeZone} extra={CONSOLE_MESSAGES}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </I18nProvider>
    </ThemeRoot>
  );
}

const el = document.getElementById('root');
if (!el) {
  throw new Error('index.html 缺少 #root');
}
createRoot(el).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
