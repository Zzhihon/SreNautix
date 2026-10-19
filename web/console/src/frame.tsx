// 登录后的框架：会话、界面能力、事件流与 @srenautix/ui 的环境（数据端口、链接）。

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { Loading, UiEnvProvider, useI18n, type LinkProps, type Links, type UiEnv } from '@srenautix/ui';
import { useMemo, type MouseEvent } from 'react';
import { port } from './api';
import { useEventStream } from './events';
import { capabilities, SessionProvider, useSessionQuery } from './session';
import { Shell } from './shell/Shell';

const links: Links = {
  inbox: () => '/incidents',
  incident: (ref, tab) => `/incidents/${encodeURIComponent(ref)}${tab ? `?tab=${tab}` : ''}`,
  run: (id) => `/runs/${id}`,
  approval: (id) => `/actions/${id}`,
  approvalExternal: false,
};

/** 普通的 <a>，点击时交给路由导航（保留中键、Ctrl 点击在新标签页打开）。 */
function RouterLink({ href, className, children, title, ...rest }: LinkProps) {
  const router = useRouter();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    void router.navigate({ href });
  };
  return (
    <a href={href} className={className} title={title} aria-label={rest['aria-label']} onClick={onClick}>
      {children}
    </a>
  );
}

export function AppFrame() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const session = useSessionQuery();
  useEventStream(qc, Boolean(session.data));
  const s = session.data;
  const env = useMemo<UiEnv | null>(
    () => (s ? { port, links, caps: capabilities(s, t), Link: RouterLink } : null),
    [s, t],
  );
  if (!s || !env) {
    // beforeLoad 已经确认登录；会话在后台刷新为 null 时由路由守卫跳转
    return <Loading />;
  }
  return (
    <SessionProvider session={s}>
      <UiEnvProvider env={env}>
        <Shell />
      </UiEnvProvider>
    </SessionProvider>
  );
}
