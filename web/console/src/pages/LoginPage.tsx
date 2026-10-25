// 登录（DESIGN §13）：OIDC 为主；本地管理员只用于首次引导，SSO 验证通过后只作为紧急入口，
// 默认必须带 TOTP；server 关闭 TOTP 时（ADR 0118）不显示验证码输入框，显示"TOTP 已关闭"。失败到一定次数会锁定（423）。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Button, EmptyState, ErrorBox, Loading, Panel, TextField, useI18n, type AuthProviders } from '@srenautix/ui';
import { useState } from 'react';
import { hub, isApiError, ok, setCsrf, type Session } from '../api';
import { SESSION_KEY } from '../session';
import styles from './pages.module.css';

export function LoginPage({ returnTo }: { returnTo?: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const providers = useQuery({
    queryKey: ['auth-providers'],
    queryFn: async () => ok<AuthProviders>('listAuthProviders', await hub.GET('/v1/auth/providers')),
  });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const totpRequired = providers.data?.local_admin.totp_required ?? true;
  const target = returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/incidents';
  const login = useMutation({
    mutationFn: async () =>
      ok<Session>(
        'loginLocal',
        await hub.POST('/v1/auth/login', {
          body: totpRequired ? { username, password, totp } : { username, password },
        }),
      ),
    onSuccess: async (s) => {
      setCsrf(s.csrf_token);
      qc.setQueryData(SESSION_KEY, s);
      // 原地址可能带查询串（例如告警链接 /alerts?l.alertname=…）：按 href 解析，查询串经路由的 parseSearch
      await navigate({ href: target });
    },
  });

  return (
    <div className={styles.login}>
      <Panel title={t('login.title')}>
        {providers.isPending ? (
          <Loading />
        ) : providers.error ? (
          <ErrorBox title={t('login.providers_failed')} error={providers.error} />
        ) : (
          <div className={styles.loginBody}>
            {providers.data.oidc && (
              <a className={styles.oidc} href={`/v1/auth/oidc/start?return_to=${encodeURIComponent(target)}`}>
                {t('login.oidc', { name: providers.data.oidc.display_name })}
              </a>
            )}
            {providers.data.local_admin.enabled ? (
              <form
                className={styles.loginForm}
                aria-label={t('login.local')}
                onSubmit={(e) => {
                  e.preventDefault();
                  login.mutate();
                }}
              >
                <h2 className={styles.h2}>{t('login.local')}</h2>
                {providers.data.local_admin.break_glass && <p className={styles.warn}>{t('login.break_glass')}</p>}
                <TextField
                  label={t('login.username')}
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.currentTarget.value)}
                  required
                />
                <TextField
                  label={t('login.password')}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                  required
                />
                {totpRequired ? (
                  <TextField
                    label={t('login.totp')}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={totp}
                    onChange={(e) => setTotp(e.currentTarget.value)}
                    required
                  />
                ) : (
                  <p className={styles.warn} role="note">
                    {t('login.totp_off')}
                  </p>
                )}
                <Button type="submit" variant="primary" size="lg" busy={login.isPending}>
                  {t('login.submit')}
                </Button>
                {login.error &&
                  (isApiError(login.error, 423) ? (
                    <ErrorBox title={t('login.locked')} error={login.error} />
                  ) : isApiError(login.error, 401) ? (
                    <p role="alert" className={styles.bad}>
                      {t('login.invalid')}
                    </p>
                  ) : (
                    <ErrorBox title={t('login.failed')} error={login.error} />
                  ))}
              </form>
            ) : (
              !providers.data.oidc && (
                <EmptyState kind="not_configured" title={t('login.none_title')} because={t('login.none_because')} />
              )
            )}
            <p className={styles.dim}>{t('login.profile', { profile: t(`profile.${providers.data.profile}`) })}</p>
          </div>
        )}
      </Panel>
    </div>
  );
}
