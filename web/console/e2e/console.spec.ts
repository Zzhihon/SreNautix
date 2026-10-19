import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCRATCH } from './hub';
import { freshTotp, gatewayHeartbeat, hubState } from './state';
import { ADMIN } from './hub';

const s = hubState();
const go = (page: Page, path: string) => page.goto(`${s.consoleUrl}${path}`);

test.describe.configure({ mode: 'serial' });

test('外壳：状态条不可关闭、导航分组、集群切换与搜索', async ({ page }) => {
  await go(page, '/incidents');
  // 状态条以 alert 或 status 角色呈现（有问题时为 alert），没有关闭按钮
  const strip = page.locator('[aria-label="系统状态"]');
  await expect(strip).toBeVisible();
  await expect(strip.getByRole('button')).toHaveCount(0);
  const nav = page.getByRole('navigation', { name: '主导航' });
  for (const g of ['值班', '处置', '度量', '系统', '治理']) {
    await expect(nav.getByText(g, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole('combobox', { name: '集群' })).toContainText('全部集群');
  await page.getByRole('combobox', { name: '集群' }).selectOption('e2e');
  await expect(page).toHaveURL(/cluster=e2e/);
  await page.getByRole('searchbox', { name: '搜索' }).fill('shop');
  await page.getByRole('searchbox', { name: '搜索' }).press('Enter');
  await expect(page).toHaveURL(/\/search\?.*q=shop/);
  await expect(page.getByRole('heading', { name: '搜索：shop' })).toBeVisible();
});

test('收件箱：事件行带处置判断、严重度、持续时长与待审批数，过滤条件写进 URL', async ({ page }) => {
  await go(page, '/incidents');
  const list = page.getByRole('list', { name: '事件列表' });
  const row = list.getByRole('link').first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('critical');
  await expect(row).toContainText('2 个待审批');
  await expect(row).toContainText(/已持续/);
  await expect(page.getByText(/接入连续性 · 最近 6 小时/)).toBeVisible();

  await page.getByRole('group', { name: '状态' }).getByRole('button', { name: '已恢复' }).click();
  await expect(page).toHaveURL(/state=resolved/);
  await expect(page.getByText('没有已恢复的事件')).toBeVisible();
  await expect(page.getByText(/接入正常，状态条件在 .* 检查过/)).toBeVisible();

  await page.getByRole('group', { name: '状态' }).getByRole('button', { name: '进行中' }).click();
  await page.getByLabel('处置判断').selectOption('ignore');
  await expect(page).toHaveURL(/disposition=ignore/);
  await expect(page.getByText('没有符合过滤条件的事件')).toBeVisible();
  await page.getByRole('button', { name: '清除过滤条件' }).click();
  await expect(list.getByRole('link').first()).toBeVisible();
});

test('事件详情：结论头、内联待审批、标签页写进 URL；不可信原文只作为文本显示', async ({ page }) => {
  await go(page, `/incidents/${s.incidentId}`);
  const head = page.getByRole('region', { name: '结论' });
  await expect(head).toBeVisible();
  await expect(head).toContainText('进行中');
  await expect(head).toContainText(s.label);
  await expect(page.getByText('待审批的提议（2）')).toBeVisible();
  await expect(page.getByRole('link', { name: '打开审批页' })).toHaveCount(2);

  await page.getByRole('tab', { name: /时间线/ }).click();
  await expect(page).toHaveURL(/tab=timeline/);
  await expect(page.getByRole('img', { name: /时间线，共 \d+ 条记录/ })).toBeVisible();
  // annotation 里的 <b> 与 {{ }} 原样显示为文本
  await expect(page.locator('main b')).toHaveCount(0);

  await page.getByRole('tab', { name: /运行/ }).click();
  await expect(page).toHaveURL(/tab=runs/);
  await page.getByRole('tab', { name: /假设/ }).click();
  await expect(page.getByText('没有阶段 B 研判')).toBeVisible();
  await page.getByRole('tab', { name: /证据/ }).click();
  await expect(page).toHaveURL(/tab=evidence/);
});

test('反馈：进行中的事件可以对处置判断与根因分别反馈，"根因错"可以不选真实根因', async ({ page }) => {
  await go(page, `/incidents/${s.incidentId}`);
  const form = page.getByRole('form', { name: '研判反馈' });
  await expect(form).toBeVisible();
  await expect(form).toContainText('事件进行中也可以反馈');
  await form.getByRole('group', { name: '处置判断' }).getByRole('button', { name: '错' }).click();
  await form.getByLabel('正确的处置判断').selectOption('escalate');
  await form.getByRole('group', { name: '根因组件' }).getByRole('button', { name: '错' }).click();
  await form.getByLabel('真实根因组件').selectOption({ label: '不知道真实根因' });
  await expect(form.getByText(/不生成回放用例/)).toBeVisible();
  await form.getByLabel('原因（可选）').fill('上游依赖先出问题');
  await form.getByRole('button', { name: '提交反馈' }).click();
  const done = page.getByRole('status').filter({ hasText: '处置判断错，应为升级' });
  await expect(done).toContainText('根因错，真实根因未知');
  await expect(done).toContainText('（console）');
});

test('审批页（L 档）：机器推导字段在前，模型理由折叠，批准后显示回执', async ({ page }) => {
  await go(page, `/actions/${s.proposals.low}`);
  await expect(page.getByRole('heading', { name: /审批：workload_scale · shop\/api/ })).toBeVisible();
  const fields = page.locator('[data-testid^="f-"]');
  await expect(fields).toHaveCount(12);
  await expect(page.getByTestId('f-action')).toContainText('L 档');
  await expect(page.getByTestId('f-prechecks')).toContainText(/服务端于 .* 重新预检/);
  await expect(page.getByRole('button', { name: /模型给出的理由（模型生成，未经验证）/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await page.getByRole('button', { name: '批准' }).click();
  const receipt = page.getByRole('region', { name: '审批回执' });
  await expect(receipt).toContainText('已批准');
  await expect(receipt).toContainText('local:admin · console');
});

test('审批页（H 档）：必须输入目标名称，并在 5 分钟内重新认证过', async ({ page }) => {
  // 浏览器时钟前进 6 分钟：距登录超过 5 分钟，界面要求重新认证
  const real = Date.now();
  await page.clock.install({ time: real + 6 * 60_000 });
  await go(page, `/actions/${s.proposals.high}`);
  await expect(page.getByTestId('f-action')).toContainText('H 档');
  await expect(page.getByTestId('f-policy')).toContainText(/self_dependency|自身依赖/);
  const approve = page.getByRole('button', { name: '批准' });
  await expect(approve).toBeDisabled();
  await expect(page.getByText('H 档审批要求 5 分钟内重新认证过。')).toBeVisible();

  const name = page.getByLabel('输入目标名称 srenautix/srenautix-worker 以确认');
  await name.fill('srenautix/srenautix-worke');
  await expect(page.getByText('与目标名称不一致')).toBeVisible();
  await name.fill('srenautix/srenautix-worker');
  await expect(approve).toBeDisabled();

  await page.getByRole('button', { name: '重新认证' }).click();
  const sheet = page.getByRole('dialog', { name: '重新认证' });
  await sheet.getByLabel('口令').fill(ADMIN.password);
  const last = Number(readFileSync(join(SCRATCH, 'totp-counter'), 'utf8'));
  const code = await freshTotp(last);
  await sheet.getByLabel('TOTP 验证码（6 位）').fill(code.code);
  await sheet.getByRole('button', { name: '确认' }).click();
  await expect(sheet).toBeHidden();
  // 时钟回到真实时间：服务端记录的认证时间在 5 分钟内
  await page.clock.setSystemTime(Date.now());
  await expect(approve).toBeEnabled();
  await approve.click();
  const receipt = page.getByRole('region', { name: '审批回执' });
  await expect(receipt).toContainText('已批准');
});

test('动作队列：待审批为空时写明原因，已批准的提议在进行中', async ({ page }) => {
  await go(page, '/actions');
  await expect(page.getByText('没有待审批的提议')).toBeVisible();
  await page.getByRole('group', { name: '队列' }).getByRole('button', { name: '进行中' }).click();
  await expect(page).toHaveURL(/tab=running/);
  const table = page.getByRole('table', { name: '提议' });
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table).toContainText('已批准');
});

test('集群：gateway 心跳正常时已连接、准入自检通过、未冻结，不显示仅提议', async ({ page }) => {
  await gatewayHeartbeat();
  await go(page, '/clusters');
  await expect(page.getByText('gateway 已连接')).toBeVisible();
  await expect(page.getByText('准入自检通过')).toBeVisible();
  await expect(page.getByText(/未冻结/)).toBeVisible();
  await expect(page.getByText('e2e 仅提议，不执行')).toHaveCount(0);
  await expect(page.getByText('仅提议', { exact: true })).toHaveCount(0);
});

test('拓扑：没有领域包时覆盖表写明原因，未映射的告警给出推断，邻域图显示 informer 写入的对象', async ({ page }) => {
  await go(page, '/topology?cluster=e2e');
  await expect(page.getByText('还没有组件')).toBeVisible();
  await expect(page.getByText(/拓扑 v\d+ 中有 Kubernetes 对象，但没有对象匹配领域包的组件类型/)).toBeVisible();
  const unmapped = page.getByRole('table', { name: '14 天内未映射的告警' });
  await expect(unmapped).toContainText('KubePodCrashLooping');
  await expect(unmapped).toContainText('症状（置信度');
  // 生成覆盖 PR 需要填写组件
  await expect(unmapped.getByRole('button', { name: '生成 PR' })).toBeDisabled();
  await page.getByRole('group', { name: '视图' }).getByRole('button', { name: '邻域图' }).click();
  await page.getByLabel('组件键').fill('Deployment:shop/api');
  await page.getByRole('button', { name: '显示' }).click();
  await expect(page.getByRole('img', { name: /根因子图：\d+ 个组件/ })).toBeVisible();
});

test('策略与目录：从 Git 渲染的策略、模拟器、软暂停与硬停止说明', async ({ page }) => {
  await go(page, '/policies?cluster=e2e');
  await expect(page.getByText('从 Git 渲染出的生效策略')).toBeVisible();
  const enabled = page.locator('section', { hasText: '启用的动作' });
  await expect(enabled).toContainText('workload_scale');
  await page.getByLabel('名称', { exact: true }).fill('api');
  await page.getByLabel('命名空间', { exact: true }).fill('shop');
  await page.getByLabel('目标类型').fill('Deployment');
  await page.getByRole('button', { name: '模拟' }).click();
  await expect(page.getByText('允许提议')).toBeVisible();
  await expect(page.getByText('用 kubectl 打开熔断开关：')).toBeVisible();

  await page.getByLabel('原因').fill('演练');
  await page.getByRole('button', { name: '暂停下发' }).click();
  await expect(page.getByText(/已暂停下发 · local:admin/)).toBeVisible();
  await page.getByRole('button', { name: '恢复下发' }).click();
  await expect(page.getByText('工单正常下发')).toBeVisible();
});

test('worker 未部署时，评测、Agent 健康与模型页面写明原因', async ({ page }) => {
  for (const [path, title] of [
    ['/eval', '读取成绩单失败'],
    ['/health', '读取 Agent 健康失败'],
    ['/models', '读取模型路由失败'],
  ] as const) {
    await go(page, path);
    const alert = page.getByRole('alert').filter({ hasText: title });
    await expect(alert).toContainText('没有配置 worker');
  }
});

test('治理：审计链、用户与角色（权限解释）、设置与 API token', async ({ page }) => {
  await go(page, '/audit');
  await expect(page.getByRole('heading', { name: '审计' })).toBeVisible();
  await expect(page.getByText('治理链')).toBeVisible();

  await go(page, '/users');
  await expect(page.getByRole('table', { name: '角色绑定' })).toContainText('group:srenautix:local-admin');
  await expect(page.getByRole('table', { name: '用户' })).toContainText('admin');
  await page.getByLabel('权限', { exact: true }).selectOption('approve');
  await page.getByLabel('审批档位').selectOption('H');
  await page.getByRole('button', { name: '解释' }).click();
  await expect(page.getByText('local:admin 被允许')).toBeVisible();
  await page.getByRole('button', { name: '生成绑定码' }).click();
  await expect(page.getByText(/绑定码 [A-Z0-9]{8}/)).toBeVisible();

  await go(page, '/settings');
  await page.getByLabel('名称', { exact: true }).fill('e2e-token');
  await page.getByRole('button', { name: '创建 token' }).click();
  await expect(page.getByText('token 只显示这一次，请立即保存：')).toBeVisible();
  const tokens = page.locator('section', { hasText: 'API token' });
  await expect(tokens.getByRole('cell', { name: 'e2e-token' })).toBeVisible();
});

test('语言与主题：切到英文与深色后文案与令牌随之变化', async ({ page }) => {
  await go(page, '/incidents');
  await page.getByRole('combobox', { name: '语言' }).selectOption('en');
  await expect(page.getByRole('heading', { name: 'Incident inbox' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Theme' }).selectOption('dark');
  await expect(page.locator('[data-scheme="dark"]').first()).toBeVisible();
  await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
  await page.getByRole('combobox', { name: '主题' }).selectOption('system');
});
