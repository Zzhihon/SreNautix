import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN, SCRATCH } from './hub';
import { freshTotp, hubState } from './state';

test('未登录访问跳转到登录页，本地管理员用口令与 TOTP 登录后回到原页面', async ({ page }) => {
  const s = hubState();
  await page.goto(`${s.consoleUrl}/actions`);
  await expect(page).toHaveURL(/\/login\?return_to=/);
  await expect(page.getByRole('heading', { name: '登录 SreNautix' })).toBeVisible();
  await expect(page.getByText('安装配置：标准配置')).toBeVisible();

  // 错误的口令：401，界面写明原因，不跳转
  await page.getByLabel('用户名').fill(ADMIN.username);
  await page.getByLabel('口令').fill('wrong password');
  const first = await freshTotp(0);
  await page.getByLabel('TOTP 验证码（6 位）').fill(first.code);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('alert')).toHaveText('用户名、口令或验证码不正确。');

  await page.getByLabel('口令').fill(ADMIN.password);
  const second = await freshTotp(first.counter);
  await page.getByLabel('TOTP 验证码（6 位）').fill(second.code);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/actions$/);
  await expect(page.getByRole('heading', { name: '动作队列' })).toBeVisible();
  // 本地管理员不是紧急入口（没有配置 OIDC），不显示横幅
  await expect(page.getByText('紧急入口')).toHaveCount(0);
  writeFileSync(join(SCRATCH, 'totp-counter'), String(second.counter));
  await page.context().storageState({ path: join(SCRATCH, 'session.json') });
});
