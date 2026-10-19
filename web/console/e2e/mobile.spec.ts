import { expect, test } from '@playwright/test';
import { hubState } from './state';

const s = hubState();

test('手机宽度：审批页与收件箱没有横向滚动，导航收进菜单按钮', async ({ page }) => {
  await page.goto(`${s.consoleUrl}/actions/${s.proposals.low}`);
  await expect(page.getByTestId('f-action')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeHidden();
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '事件收件箱' }).click();
  await expect(page.getByRole('heading', { name: '事件收件箱' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
