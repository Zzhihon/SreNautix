// Grafana 管理员的邮箱对应的 OIDC 用户在控制台登录一次：server 只把插件请求里的
// X-SreNautix-On-Behalf-Of 邮箱映射到登录过的用户，没有登录过时插件的数据请求得到 403。

import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { OIDC_USER, STATE_FILE, type GrafanaState } from './grafana.ts';

const s = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as GrafanaState;

test('OIDC 用户在控制台登录一次', async ({ page }) => {
  await page.goto(`${s.hub.consoleUrl}/login`);
  await page.getByRole('link', { name: /^使用 .* 登录$/ }).click();
  // node-oidc-provider 的开发登录页接受任意口令
  await page.locator('input[name="login"]').fill(OIDC_USER.sub);
  await page.locator('input[name="password"]').fill('any');
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(`^${s.hub.consoleUrl}/(?!login)`), { timeout: 30_000 });
});
