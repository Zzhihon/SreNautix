import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { GRAFANA_ADMIN, PLUGIN_ID, STATE_FILE, type GrafanaState } from './grafana.ts';

const s = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as GrafanaState;
const app = `${s.grafanaUrl}/a/${PLUGIN_ID}`;

/**
 * 记录页面错误与失败请求。modules=true 只看插件代码本身（module.js 与共享模块，jsx-runtime 没有共享时
 * SystemJS 请求 /react/jsx-runtime 得到 404）；否则也包括经插件后端访问中心的接口。
 */
function watch(page: Page, modules = false) {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().includes('Could not load plugin')) {
      problems.push(`console: ${m.text()}`);
    }
  });
  page.on('response', (r) => {
    const u = r.url();
    const api = u.includes(`/api/plugins/${PLUGIN_ID}/resources/`);
    if (r.status() >= 400 && (u.includes(PLUGIN_ID) || /jsx-runtime|\/react\b/.test(u)) && !(modules && api)) {
      problems.push(`${r.status()} ${u}`);
    }
  });
  return problems;
}

async function login(page: Page) {
  await page.goto(`${s.grafanaUrl}/login`);
  await page.getByLabel(/Email or username/i).fill(GRAFANA_ADMIN.user);
  await page.getByLabel(/^Password/i).fill(GRAFANA_ADMIN.password);
  await page.getByRole('button', { name: /Log in/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test('插件在 Grafana 中加载：共享 React 与 jsx-runtime，没有 404 与页面错误', async ({ page }) => {
  const problems = watch(page, true);
  await login(page);
  await page.goto(`${app}/incidents`);
  await expect(page.getByRole('heading', { name: 'Incident inbox' })).toBeVisible();
  await expect(page.locator('[aria-label="System status"]')).toBeVisible();
  expect(problems).toEqual([]);
  const settings = await page.request.get(`${s.grafanaUrl}/api/plugins/${PLUGIN_ID}/settings`);
  const body = (await settings.json()) as { enabled: boolean; jsonData: { hubUrl: string } };
  expect(body.enabled).toBe(true);
  expect(body.jsonData.hubUrl).toBe(s.hub.apiUrl);
});

test('收件箱与事件详情经插件后端读取中心的数据；"批准"打开控制台的审批页', async ({ page }) => {
  const problems = watch(page);
  await login(page);
  await page.goto(`${app}/incidents`);
  const row = page.getByRole('list', { name: 'Incidents' }).getByRole('link').first();
  await expect(row).toContainText('critical');
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/a/${PLUGIN_ID}/incidents/`));
  await expect(page.getByText('Proposals awaiting approval (2)')).toBeVisible();
  const approve = page.getByRole('link', { name: 'Approve in the console' }).first();
  await expect(approve).toHaveAttribute('href', new RegExp(`^${s.hub.consoleUrl}/actions/`));
  await expect(approve).toHaveAttribute('target', '_blank');
  // 插件里没有实时重跑与审批按钮
  await expect(page.getByRole('button', { name: 'Rerun live' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('反馈经插件后端提交，渠道记为 grafana', async ({ page }) => {
  await login(page);
  await page.goto(`${app}/incidents/${s.hub.incidentId}`);
  const form = page.getByRole('form', { name: 'Research feedback' });
  await form.getByRole('group', { name: 'Disposition' }).getByRole('button', { name: 'Right' }).click();
  await form.getByRole('button', { name: 'Submit feedback' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Disposition right' })).toContainText('(grafana)');
});

test('插件后端拒绝审批、撤销、实时重跑与原始提示词，不转发给中心', async ({ page }) => {
  await login(page);
  const base = `${s.grafanaUrl}/api/plugins/${PLUGIN_ID}/resources`;
  for (const [method, path] of [
    ['POST', `/v1/proposals/${s.hub.proposals.low}/approve`],
    ['POST', `/v1/proposals/${s.hub.proposals.low}/undo`],
    ['POST', `/v1/incidents/${s.hub.incidentId}/evidence/rerun`],
    ['GET', `/v1/runs/00000000-0000-4000-8000-000000000000/prompt/raw`],
    ['PUT', '/v1/pause'],
  ] as const) {
    const r = await page.request.fetch(`${base}${path}`, {
      method,
      data: method === 'GET' ? undefined : {},
      headers: { 'content-type': 'application/json', 'x-grafana-org-id': '1' },
    });
    expect(r.status(), `${method} ${path}`).toBe(403);
  }
});
