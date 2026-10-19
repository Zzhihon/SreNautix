import { readFileSync } from 'node:fs';
import { Secret, TOTP } from 'otpauth';
import { CLUSTER, STATE_FILE, TOKENS, type HubState } from './hub';

export function hubState(): HubState {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as HubState;
}

/** 以 gateway 身份经真实接口上报一次心跳（gateway 在生产中持续上报；超过时限没有心跳的集群显示为仅提议）。 */
export async function gatewayHeartbeat(): Promise<void> {
  const s = hubState();
  const r = await fetch(`${s.apiUrl}/v1/spoke/heartbeat`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKENS.gateway}`,
      'x-srenautix-cluster': CLUSTER,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      gateway_id: 'gw-0',
      version: '0.1.0',
      leader: true,
      propose_only: false,
      conditions: [
        {
          type: 'AdmissionSelfCheck',
          status: 'True',
          reason: 'Denied',
          since: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        },
      ],
      queue: [],
      clock_skew_seconds: { apiserver: 0.1 },
    }),
  });
  if (r.status !== 200) {
    throw new Error(`gateway 心跳：${r.status} ${await r.text()}`);
  }
}

/** 下一个尚未使用过的 TOTP 码：server 记录每个用户最后使用的计数，同一个时间窗内的码只能用一次。 */
export async function freshTotp(after: number): Promise<{ code: string; counter: number }> {
  const totp = new TOTP({ secret: Secret.fromBase32(hubState().totpSecret), digits: 6, period: 30, algorithm: 'SHA1' });
  for (;;) {
    const counter = totp.counter();
    if (counter > after) {
      return { code: totp.generate(), counter };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
