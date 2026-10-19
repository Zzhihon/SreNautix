import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { validatorFor } from '@srenautix/contract';
import canonicalize from 'canonicalize';
import { visit } from 'jsonc-parser';

/**
 * 审批断言 v1（contract/gateway/v1，ADR 0020）的规范化、签发与校验。server 签发服务签名；
 * 校验函数与 Go 侧 internal/spoke/gateway/assertion 对同一组黄金向量给出相同的原因码。
 */
export const CANON_VERSION = 'jcs-sha256-v1';
export const SERVICE_SIGNING_PREFIX = 'srenautix-approval-v1\n';
export const MAX_REAUTH_AGE_MS = 5 * 60_000;
export const MAX_ISSUE_SKEW_MS = 5_000;

export interface ApprovalAssertion {
  proposal_id: string;
  action: string;
  level: 'reversible' | 'reversible_recreatable' | 'compensable' | 'irreversible';
  tier: 'L' | 'H';
  params_hash: string;
  canon_version: 'jcs-sha256-v1';
  target_uid: string;
  cluster: string;
  incident_version: number;
  root_component: string;
  evidence_fingerprint: string;
  approver_principal: string;
  channel: string;
  issued_at: string;
  expires_at: string;
}

export interface Reauth {
  method: 'oidc_max_age' | 'local_totp';
  auth_time: string;
  session_hash: string;
}

export interface ServiceProof {
  type: 'service_ed25519';
  key_id: string;
  signature: string;
  reauth?: Reauth;
}

export interface WebAuthnProof {
  type: 'webauthn_ed25519';
  credential_id: string;
  authenticator_data: string;
  client_data_json: string;
  signature: string;
}

export interface ApprovalEnvelope {
  assertion: ApprovalAssertion;
  proof: ServiceProof | WebAuthnProof;
}

export class AssertionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

const fail = (code: string, msg: string) => new AssertionError(code, msg);

/** 从 JSON 文本规范化；出现重复的键时失败（JCS 要求）。 */
export function canonicalText(text: string): string {
  const stack: Array<Set<string>> = [];
  let dup: string | null = null;
  visit(text, {
    onObjectBegin: () => {
      stack.push(new Set());
    },
    onObjectEnd: () => {
      stack.pop();
    },
    onObjectProperty: (name) => {
      const top = stack[stack.length - 1] as Set<string>;
      if (top.has(name)) {
        dup = name;
      }
      top.add(name);
    },
  });
  if (dup !== null) {
    throw fail('schema_invalid', `JSON 中有重复的键 ${dup}`);
  }
  return canonical(JSON.parse(text));
}

export function canonical(v: unknown): string {
  const s = canonicalize(v);
  if (s === undefined) {
    throw fail('schema_invalid', '无法规范化的值');
  }
  return s;
}

export function sha256Prefixed(s: string | Buffer): string {
  return `sha256:${createHash('sha256').update(s).digest('hex')}`;
}

export function paramsHash(params: unknown): string {
  return sha256Prefixed(canonical(params));
}

export function assertionHash(a: ApprovalAssertion): string {
  return sha256Prefixed(canonical(a));
}

/** ActionExecution 的名称：sha256("srenautix-execution-v1\n" + proposal_id + "\n" + assertion_hash) 的前 32 位十六进制。 */
export function executionId(proposalId: string, aHash: string): string {
  return createHash('sha256').update(`srenautix-execution-v1\n${proposalId}\n${aHash}`).digest('hex').slice(0, 32);
}

export function serviceSigningInput(a: ApprovalAssertion, reauth: Reauth | undefined): Buffer {
  const statement = reauth ? { assertion: a, reauth } : { assertion: a };
  return Buffer.from(SERVICE_SIGNING_PREFIX + canonical(statement), 'utf8');
}

const b64u = (b: Buffer) => b.toString('base64url');

export function ed25519FromSeed(seedHex: string): KeyObject {
  // PKCS#8 的 Ed25519 私钥前缀加 32 字节种子
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seedHex, 'hex')]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

export function ed25519Public(raw32B64u: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw32B64u }, format: 'jwk' });
}

export function publicKeyB64u(k: KeyObject): string {
  const pub = k.type === 'public' ? k : createPublicKey(k);
  const jwk = pub.export({ format: 'jwk' }) as { x: string };
  return jwk.x;
}

/** 签发服务签名信封；H 档必须带重新认证凭据。 */
export function signService(a: ApprovalAssertion, key: KeyObject, keyId: string, reauth?: Reauth): ApprovalEnvelope {
  if (a.tier === 'H' && !reauth) {
    throw fail('reauth_required', 'H 档服务签名必须携带重新认证凭据');
  }
  const signature = b64u(sign(null, serviceSigningInput(a, reauth), key));
  const proof: ServiceProof = reauth
    ? { type: 'service_ed25519', key_id: keyId, signature, reauth }
    : { type: 'service_ed25519', key_id: keyId, signature };
  return { assertion: a, proof };
}

export interface Keyring {
  service: Map<string, { key: KeyObject; notAfter: Date | null }>;
  webauthn: Map<string, { key: KeyObject; principal: string }>;
  rpId: string | null;
  origins: Set<string>;
}

interface ApproverKeysFile {
  version: 1;
  webauthn?: { rp_id: string; origins: string[] };
  keys: Array<
    | { use: 'service'; key_id: string; public_key: string; not_after?: string }
    | { use: 'webauthn'; credential_id: string; principal: string; public_key: string }
  >;
}

export function keyringFrom(file: ApproverKeysFile): Keyring {
  const v = validatorFor('gateway/v1/approver-keys.schema.json');
  if (!v(file)) {
    throw new Error(`审批人公钥文件不合法：${JSON.stringify(v.errors)}`);
  }
  const k: Keyring = {
    service: new Map(),
    webauthn: new Map(),
    rpId: file.webauthn?.rp_id ?? null,
    origins: new Set(file.webauthn?.origins ?? []),
  };
  for (const e of file.keys) {
    if (e.use === 'service') {
      k.service.set(e.key_id, {
        key: ed25519Public(e.public_key),
        notAfter: e.not_after ? new Date(e.not_after) : null,
      });
    } else {
      k.webauthn.set(e.credential_id, { key: ed25519Public(e.public_key), principal: e.principal });
    }
  }
  return k;
}

const TS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/;

function parseTs(s: string, what: string): Date {
  if (!TS.test(s)) {
    throw fail('schema_invalid', `${what} 不是 UTC RFC 3339 时间`);
  }
  return new Date(s);
}

/** 按 ADR 0020 的顺序校验信封：schema → 签名（服务或通行密钥）。返回断言哈希。 */
export function verifyEnvelope(
  envelope: unknown,
  keys: Keyring,
  opts: { requireWebAuthnForH: boolean },
): { hash: string; envelope: ApprovalEnvelope } {
  const v = validatorFor('gateway/v1/approval-envelope.schema.json');
  if (!v(envelope)) {
    throw fail('schema_invalid', JSON.stringify(v.errors));
  }
  const env = envelope as ApprovalEnvelope;
  const a = env.assertion;
  const issued = parseTs(a.issued_at, 'issued_at');
  const hash = assertionHash(a);
  if (env.proof.type === 'service_ed25519') {
    if (a.tier === 'H' && opts.requireWebAuthnForH) {
      throw fail('webauthn_required', 'H 档审批在合规配置下必须使用通行密钥签名');
    }
    const p = env.proof;
    const k = keys.service.get(p.key_id);
    if (!k) {
      throw fail('unknown_key', `服务签名密钥 ${p.key_id} 不受信任`);
    }
    if (k.notAfter && issued.getTime() >= k.notAfter.getTime()) {
      throw fail('key_expired', `密钥 ${p.key_id} 只签 ${k.notAfter.toISOString()} 之前的断言`);
    }
    const sig = Buffer.from(p.signature, 'base64url');
    if (sig.length !== 64 || !verify(null, serviceSigningInput(a, p.reauth), k.key, sig)) {
      throw fail('bad_signature', `服务签名不能用密钥 ${p.key_id} 校验`);
    }
    if (a.tier === 'H') {
      if (!p.reauth) {
        throw fail('reauth_required', 'H 档服务签名必须携带重新认证凭据');
      }
      const at = parseTs(p.reauth.auth_time, 'reauth.auth_time');
      if (at.getTime() > issued.getTime() || issued.getTime() - at.getTime() > MAX_REAUTH_AGE_MS) {
        throw fail('reauth_stale', '重新认证时间晚于签发时间，或相差超过 5 分钟');
      }
    }
    return { hash, envelope: env };
  }
  const p = env.proof;
  if (!keys.rpId) {
    throw fail('webauthn_not_configured', '审批人公钥没有 webauthn 设置');
  }
  const cred = keys.webauthn.get(p.credential_id);
  if (!cred) {
    throw fail('webauthn_unknown_credential', `通行密钥 ${p.credential_id} 未登记`);
  }
  if (cred.principal !== a.approver_principal) {
    throw fail('webauthn_principal_mismatch', `凭据属于 ${cred.principal}，断言写的是 ${a.approver_principal}`);
  }
  const cdj = Buffer.from(p.client_data_json, 'base64url');
  let cd: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    cd = JSON.parse(cdj.toString('utf8')) as typeof cd;
  } catch {
    throw fail('webauthn_bad_client_data', 'client_data_json 不是 JSON');
  }
  if (cd.type !== 'webauthn.get') {
    throw fail('webauthn_bad_client_data', `clientData.type 为 ${String(cd.type)}`);
  }
  const challenge = b64u(createHash('sha256').update(canonical(a)).digest());
  if (cd.challenge !== challenge) {
    throw fail('webauthn_challenge_mismatch', 'challenge 与本断言不对应');
  }
  if (typeof cd.origin !== 'string' || !keys.origins.has(cd.origin)) {
    throw fail('webauthn_origin', `origin ${String(cd.origin)} 不在白名单中`);
  }
  const ad = Buffer.from(p.authenticator_data, 'base64url');
  if (ad.length < 37) {
    throw fail('webauthn_bad_client_data', 'authenticator_data 短于 37 字节');
  }
  if (!ad.subarray(0, 32).equals(createHash('sha256').update(keys.rpId).digest())) {
    throw fail('webauthn_rp_id', `rpIdHash 与 ${keys.rpId} 不一致`);
  }
  const flags = ad[32] as number;
  if ((flags & 0x01) === 0 || (flags & 0x04) === 0) {
    throw fail('webauthn_flags', '缺少 UP 或 UV 标志');
  }
  const sig = Buffer.from(p.signature, 'base64url');
  const msg = Buffer.concat([ad, createHash('sha256').update(cdj).digest()]);
  if (sig.length !== 64 || !verify(null, msg, cred.key, sig)) {
    throw fail('webauthn_bad_signature', '通行密钥签名校验失败');
  }
  return { hash, envelope: env };
}

export interface BindingCheck {
  proposal_id: string;
  action: string;
  params: unknown;
  target_uid: string;
  cluster: string;
  incident_version: number;
  root_component: string;
  evidence_fingerprint: string;
  proposal_expires_at: Date | null;
}

/** 绑定与时效（ADR 0020 第 5 条的 3、4 两步）。 */
export function checkBinding(a: ApprovalAssertion, b: BindingCheck, now: Date, restoredAt: Date | null): void {
  if (a.proposal_id !== b.proposal_id) throw fail('binding_proposal_id', `${a.proposal_id} ≠ ${b.proposal_id}`);
  if (a.action !== b.action) throw fail('binding_action', `${a.action} ≠ ${b.action}`);
  if (a.params_hash !== paramsHash(b.params)) throw fail('binding_params_hash', '参数哈希不一致');
  if (a.target_uid !== b.target_uid) throw fail('binding_target_uid', `${a.target_uid} ≠ ${b.target_uid}`);
  if (a.cluster !== b.cluster) throw fail('binding_cluster', `${a.cluster} ≠ ${b.cluster}`);
  if (a.incident_version !== b.incident_version)
    throw fail('binding_incident_version', `${a.incident_version} ≠ ${b.incident_version}`);
  if (a.root_component !== b.root_component)
    throw fail('binding_root_component', `${a.root_component} ≠ ${b.root_component}`);
  if (a.evidence_fingerprint !== b.evidence_fingerprint) throw fail('binding_evidence_fingerprint', '证据指纹不一致');
  const issued = parseTs(a.issued_at, 'issued_at');
  const expires = parseTs(a.expires_at, 'expires_at');
  if (expires.getTime() <= issued.getTime()) throw fail('expires_before_issue', 'expires_at 不晚于 issued_at');
  if (issued.getTime() > now.getTime() + MAX_ISSUE_SKEW_MS)
    throw fail('not_yet_valid', 'issued_at 超前当前时间 5 秒以上');
  if (now.getTime() >= expires.getTime()) throw fail('expired', `审批已于 ${a.expires_at} 过期`);
  if (b.proposal_expires_at && now.getTime() >= b.proposal_expires_at.getTime())
    throw fail('proposal_expired', '提议 TTL 已过');
  if (restoredAt && issued.getTime() <= restoredAt.getTime())
    throw fail('issued_before_restore', 'issued_at 不晚于恢复标记');
}

/** 断言里的时间：UTC，秒级，Z 结尾。 */
export function formatTs(d: Date): string {
  return new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}
