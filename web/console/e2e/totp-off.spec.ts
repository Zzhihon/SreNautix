import { expect, test } from '@playwright/test';
import { ADMIN, startServerVariant } from './hub';

// identity.local_admin.totp_required=false（ADR 0118）：以同一个库再启动一个关闭 TOTP 的 server，
// 本地管理员在登录页只填口令即可登录；登录页与设置页显示"TOTP 已关闭"。
let server: { url: string; stop(): Promise<void> };

test.beforeAll(async () => {
  test.setTimeout(180_000);
  server = await startServerVariant('server-totp-off', (config) => {
    const identity = config.identity as { local_admin: Record<string, unknown> };
    identity.local_admin.totp_required = false;
  });
});

test.afterAll(async () => {
  await server?.stop();
});

test('TOTP 关闭时本地管理员只用口令登录，登录页与设置页显示"TOTP 已关闭"', async ({ page }) => {
  await page.goto(`${server.url}/login?return_to=%2Fincidents`);
  await expect(page.getByRole('heading', { name: '登录 SreNautix' })).toBeVisible();
  await expect(page.getByText(/^TOTP 已关闭：本地管理员只凭口令登录/)).toBeVisible();
  await expect(page.getByLabel('TOTP 验证码（6 位）')).toHaveCount(0);

  // 错误的口令仍然被拒绝
  await page.getByLabel('用户名').fill(ADMIN.username);
  await page.getByLabel('口令').fill('wrong password');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('alert')).toBeVisible();

  await page.getByLabel('口令').fill(ADMIN.password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/incidents$/);

  await page.goto(`${server.url}/settings`);
  const notice = page.locator('section', { hasText: 'TOTP 已关闭' });
  await expect(notice.getByRole('note')).toContainText('identity.local_admin.totp_required=false');
});
