// notify/v1 与 approve/v1 一致性测试（DESIGN §10.3、§9.2、§11）：
// - 签名测试向量：渠道回调的签名校验对每个向量给出期望的真伪；
// - 未绑定的账号点击批准必须被拒绝（not_linked）；
// - 同一回调重放必须被拒绝（replayed 或 already_decided），不能产生第二次审批；
// - 过期的回调必须被拒绝（expired）；
// - 来源校验：对请求体签名的渠道（飞书），篡改过的回调必须在签名校验处被拒绝；
//   只靠请求头共享密钥的渠道（Telegram webhook 的 X-Telegram-Bot-Api-Secret-Token），请求体没有签名，
//   改为检查密钥错误的回调在来源校验处被拒绝；
// - 编辑是幂等的：同一内容编辑两次，第二次不报错，也不改变消息。
// 被测对象由渠道实现提供（服务端的 Telegram、飞书适配器），在它自己的集成测试里用真实的状态库运行本套件。

import type { ApprovalOutcome } from '@srenautix/contract';
import { Checks, expectEq, type ConformanceReport } from './report.js';

export interface RawCallback {
  headers: Record<string, string>;
  body: string;
}

export interface SignatureVector {
  name: string;
  headers: Record<string, string>;
  body: string;
  now_ms: number;
  valid: boolean;
}

export interface ApproveSubject {
  name: string;
  /**
   * 回调的可信依据：body_signature 表示请求体带签名；
   * transport_secret 表示只校验请求头里的共享密钥，请求体没有签名
   */
  readonly authenticity: 'body_signature' | 'transport_secret';
  /** authenticity 为 transport_secret 时必须提供：返回同一回调、但共享密钥换成错误值的副本 */
  forgeSecret?(raw: RawCallback): RawCallback;
  /** 只做签名与来源校验，不做业务处理 */
  verify(raw: RawCallback, nowMs: number): Promise<boolean>;
  /** 构造一条点击"批准"按钮的回调，渠道原生格式并已签名；proposal 由被测对象事先建好（L 档、待审批） */
  approveCallback(input: { channelUserId: string; nowMs: number }): Promise<RawCallback>;
  /** 处理回调；签名不通过时返回 bad_signature，否则返回 ApprovalOutcome.outcome */
  deliver(raw: RawCallback, nowMs: number): Promise<ApprovalOutcome['outcome'] | 'bad_signature'>;
  /** 把渠道账号绑定到一个有审批权限的主体 */
  link(channelUserId: string): Promise<void>;
  /** 回调被视为过期所需的时长 */
  readonly expiryMs: number;
  /** 发送一条消息后用同一内容编辑两次，返回两次编辑的结果与编辑后渠道上的消息内容 */
  editTwice(): Promise<{ results: Array<'edited' | 'not_modified'>; before: string; after: string }>;
}

/** 篡改请求体中的一个字符，签名必然失效 */
function tamper(raw: RawCallback): RawCallback {
  const i = Math.floor(raw.body.length / 2);
  const ch = raw.body[i] === 'A' ? 'B' : 'A';
  return { headers: raw.headers, body: raw.body.slice(0, i) + ch + raw.body.slice(i + 1) };
}

export async function runApproveConformance(
  s: ApproveSubject,
  vectors: SignatureVector[],
  nowMs: number,
): Promise<ConformanceReport> {
  const c = new Checks('approve/v1', s.name);

  await c.run('signature-vectors', '签名测试向量', async () => {
    if (!vectors.length) {
      throw new Error('没有签名测试向量');
    }
    const wrong: string[] = [];
    for (const v of vectors) {
      if ((await s.verify({ headers: v.headers, body: v.body }, v.now_ms)) !== v.valid) {
        wrong.push(`${v.name}（期望 ${v.valid ? '有效' : '无效'}）`);
      }
    }
    expectEq('不符的向量', wrong, []);
    return `${vectors.length} 个向量`;
  });
  await c.run('unlinked', '未绑定的账号不能审批', async () => {
    const raw = await s.approveCallback({ channelUserId: 'conformance-unlinked', nowMs });
    expectEq('结果', await s.deliver(raw, nowMs), 'not_linked');
    return 'not_linked';
  });
  const forged = s.authenticity === 'body_signature' ? '篡改过请求体的回调' : '共享密钥错误的回调';
  await c.run('tampered', `${forged}在来源校验处拒绝`, async () => {
    await s.link('conformance-tamper');
    const raw = await s.approveCallback({ channelUserId: 'conformance-tamper', nowMs });
    let bad: RawCallback;
    if (s.authenticity === 'body_signature') {
      bad = tamper(raw);
    } else {
      if (!s.forgeSecret) {
        throw new Error('authenticity 为 transport_secret 时必须提供 forgeSecret');
      }
      bad = s.forgeSecret(raw);
      if (bad.body !== raw.body || JSON.stringify(bad.headers) === JSON.stringify(raw.headers)) {
        throw new Error('forgeSecret 必须只修改请求头中的共享密钥');
      }
    }
    expectEq('结果', await s.deliver(bad, nowMs), 'bad_signature');
    return `${forged}：bad_signature`;
  });
  await c.run('expired', '过期的回调拒绝', async () => {
    await s.link('conformance-late');
    const raw = await s.approveCallback({ channelUserId: 'conformance-late', nowMs });
    expectEq('结果', await s.deliver(raw, nowMs + s.expiryMs + 1000), 'expired');
    return 'expired';
  });
  await c.run('approve-then-replay', '已绑定账号审批成功，重放同一回调被拒绝', async () => {
    await s.link('conformance-linked');
    const raw = await s.approveCallback({ channelUserId: 'conformance-linked', nowMs });
    expectEq('第一次', await s.deliver(raw, nowMs), 'approved');
    const again = await s.deliver(raw, nowMs + 1000);
    if (again !== 'replayed' && again !== 'already_decided') {
      throw new Error(`重放得到 ${again}，期望 replayed 或 already_decided`);
    }
    return `approved，重放 ${again}`;
  });
  await c.run('idempotent-edit', '编辑是幂等的', async () => {
    const r = await s.editTwice();
    expectEq('第一次编辑', r.results[0], 'edited');
    if (r.results[1] !== 'edited' && r.results[1] !== 'not_modified') {
      throw new Error(`第二次编辑得到 ${String(r.results[1])}`);
    }
    if (r.after !== r.before) {
      throw new Error('第二次编辑改变了消息内容');
    }
    return `第二次 ${r.results[1]}`;
  });
  return c.report();
}
