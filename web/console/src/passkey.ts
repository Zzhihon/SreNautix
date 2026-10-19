// 合规配置下 H 档审批的通行密钥签名（DESIGN §9.2、§13）：中心按提议的参数哈希与绑定字段生成挑战，
// 浏览器用审批人的通行密钥签名，断言随审批请求提交，gateway 执行前校验。

import { startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import type { PasskeyHook, WebAuthnAssertion } from '@srenautix/ui';
import { hub, ok } from './api';

type Options = Parameters<typeof startAuthentication>[0]['optionsJSON'];

export function passkeyHook(needed: boolean): PasskeyHook {
  return {
    needed,
    sign: async (proposalId) => {
      if (!browserSupportsWebAuthn()) {
        throw new Error('当前浏览器不支持通行密钥（WebAuthn）：在飞书等内嵌浏览器中请改用系统浏览器打开控制台');
      }
      const optionsJSON = ok<Options>(
        'webauthnAssertionOptions',
        await hub.POST('/v1/auth/webauthn/assertion-options', {
          params: { header: { 'X-CSRF-Token': '' } },
          body: { proposal_id: proposalId },
        }),
      );
      const assertion = await startAuthentication({ optionsJSON });
      return assertion as unknown as WebAuthnAssertion;
    },
  };
}
