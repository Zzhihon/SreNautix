import { createECDH } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AssertionError,
  assertionHash,
  canonicalText,
  checkBinding,
  ed25519FromSeed,
  executionId,
  keyringFrom,
  paramsHash,
  publicKeyB64u,
  serviceSigningInput,
  signService,
  verifyEnvelope,
  type ApprovalAssertion,
} from '../../src/proposals/assertion.js';

/** contract/gateway/v1/testvectors/approval-vectors.json：Go 与 TS 必须对每个用例给出相同的原因码。 */
const V = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../../contract/gateway/v1/testvectors/approval-vectors.json'),
    'utf8',
  ),
) as {
  keys: Record<string, { public_key: string; seed_hex: string }>;
  approver_keys: Parameters<typeof keyringFrom>[0];
  canonicalization: Array<{ name: string; input: string; canonical: string; sha256: string }>;
  canonicalization_errors: Array<{ name: string; input: string }>;
  params_hash: Array<{ name: string; params: unknown; canonical: string; params_hash: string }>;
  envelopes: Array<{
    name: string;
    envelope: { assertion: ApprovalAssertion; proof: { type: string; reauth?: unknown } };
    binding: {
      proposal_id: string;
      action: string;
      params: unknown;
      target_uid: string;
      cluster: string;
      incident_version: number;
      root_component: string;
      evidence_fingerprint: string;
      proposal_expires_at: string;
    };
    now: string;
    restored_at: string | null;
    require_webauthn_for_h: boolean;
    assertion_hash: string;
    execution_id: string;
    signing_input_b64url?: string;
    expect_error: string;
  }>;
};

const keyring = keyringFrom(V.approver_keys);

describe('规范化', () => {
  it.each(V.canonicalization.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    expect(canonicalText(c.input)).toBe(c.canonical);
  });
  it.each(V.canonicalization_errors.map((c) => [c.name, c] as const))('%s 失败', (_n, c) => {
    expect(() => canonicalText(c.input)).toThrow(AssertionError);
  });
  it.each(V.params_hash.map((c) => [c.name, c] as const))('参数哈希 %s', (_n, c) => {
    expect(paramsHash(c.params)).toBe(c.params_hash);
  });
});

describe('密钥', () => {
  it('种子派生出的公钥与向量一致', () => {
    for (const k of Object.values(V.keys)) {
      expect(publicKeyB64u(ed25519FromSeed(k.seed_hex))).toBe(k.public_key);
    }
  });
});

describe('信封', () => {
  it.each(V.envelopes.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    let code = '';
    try {
      const { hash, envelope } = verifyEnvelope(c.envelope, keyring, { requireWebAuthnForH: c.require_webauthn_for_h });
      expect(hash).toBe(c.assertion_hash);
      expect(executionId(envelope.assertion.proposal_id, hash)).toBe(c.execution_id);
      checkBinding(
        envelope.assertion,
        {
          ...c.binding,
          proposal_expires_at: c.binding.proposal_expires_at ? new Date(c.binding.proposal_expires_at) : null,
        },
        new Date(c.now),
        c.restored_at ? new Date(c.restored_at) : null,
      );
    } catch (e) {
      if (!(e instanceof AssertionError)) {
        throw e;
      }
      code = e.code;
    }
    expect(code).toBe(c.expect_error);
  });

  it('server 签出的 L 档与 H 档信封与向量逐字节相同', () => {
    const key = ed25519FromSeed((V.keys['service-2026-10'] as { seed_hex: string }).seed_hex);
    for (const name of ['service_l_valid', 'service_h_valid_reauth']) {
      const c = V.envelopes.find((x) => x.name === name)!;
      const env = signService(c.envelope.assertion, key, 'service-2026-10', c.envelope.proof.reauth as never);
      expect(env).toEqual(c.envelope);
      expect(assertionHash(env.assertion)).toBe(c.assertion_hash);
      if (c.signing_input_b64url) {
        expect(serviceSigningInput(env.assertion, c.envelope.proof.reauth as never).toString('base64url')).toBe(
          c.signing_input_b64url,
        );
      }
    }
  });
});

/** contract/gateway/v1/testvectors/approval-vectors-es256.json：ES256 通行密钥与算法混淆，Go 与 TS 给出相同的原因码。 */
const E = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../../contract/gateway/v1/testvectors/approval-vectors-es256.json'),
    'utf8',
  ),
) as {
  keys: Record<string, { alg: 'EdDSA' | 'ES256'; public_key: string; seed_hex: string }>;
  approver_keys: Parameters<typeof keyringFrom>[0];
  approver_keys_errors: Array<{ name: string; approver_keys: Parameters<typeof keyringFrom>[0] }>;
  envelopes: Array<(typeof V.envelopes)[number]>;
};

describe('ES256 通行密钥', () => {
  const es = keyringFrom(E.approver_keys);

  it('种子派生出的公钥与向量一致（ES256 的种子是 P-256 标量）', () => {
    for (const k of Object.values(E.keys)) {
      if (k.alg === 'EdDSA') {
        expect(publicKeyB64u(ed25519FromSeed(k.seed_hex))).toBe(k.public_key);
      } else {
        expect(p256PublicB64u(k.seed_hex)).toBe(k.public_key);
      }
    }
  });

  it.each(E.envelopes.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    let code = '';
    try {
      const { hash } = verifyEnvelope(c.envelope, es, { requireWebAuthnForH: c.require_webauthn_for_h });
      expect(hash).toBe(c.assertion_hash);
      checkBinding(
        c.envelope.assertion,
        {
          ...c.binding,
          proposal_expires_at: c.binding.proposal_expires_at ? new Date(c.binding.proposal_expires_at) : null,
        },
        new Date(c.now),
        c.restored_at ? new Date(c.restored_at) : null,
      );
    } catch (e) {
      if (!(e instanceof AssertionError)) {
        throw e;
      }
      code = e.code;
    }
    expect(code).toBe(c.expect_error);
  });

  it.each(E.approver_keys_errors.map((c) => [c.name, c] as const))('公钥文件 %s 不能加载', (_n, c) => {
    expect(() => keyringFrom(c.approver_keys)).toThrow();
  });
});

/** P-256 标量 → 未压缩公钥点的 base64url */
function p256PublicB64u(seedHex: string): string {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(seedHex, 'hex'));
  return ecdh.getPublicKey().toString('base64url');
}
