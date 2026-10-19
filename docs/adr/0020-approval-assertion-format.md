# 0020 审批断言的格式、规范化与签名

## 背景

gateway 是被管集群中唯一的写身份。它执行的每个动作都必须能追溯到一次审批，并且审批要绑定到具体的提议、参数、目标与事件版本（DESIGN §9.2，不变量 5）。server 签发断言，gateway 校验断言；两边分别用 TypeScript 与 Go 实现，必须对同一份断言算出同一个哈希。

## 决定

1. **字段**：断言 v1 的字段固定为 DESIGN §9.2 列出的 15 个，全部必填，不允许其他字段（`contract/gateway/v1/approval-assertion.schema.json`）。
   - `level` 取 `reversible`、`reversible_recreatable`、`compensable`、`irreversible`；`tier` 取 `L`、`H`。
   - `target_uid` 是目标对象的 `metadata.uid`；`gitops_pr` 的目标是仓库，`target_uid` 是 base 分支被批准时的提交 SHA。
   - 自动执行的断言 `channel` 为 `auto`，`approver_principal` 为 `auto:<规则名>`。
2. **规范化**：`canon_version = jcs-sha256-v1`，即 RFC 8785 JCS、UTF-8、SHA-256，结果写成 `sha256:` 加 64 位小写十六进制。重复的键使规范化失败。
   - `params_hash = sha256(JCS(params))`。执行后校验的 PromQL 条件放在 `params.verify` 中，一起计入哈希。
   - `assertion_hash = sha256(JCS(assertion))`。
   - `execution_id` 取 `sha256("srenautix-execution-v1\n" + proposal_id + "\n" + assertion_hash)` 十六进制的前 32 位，用作 `ActionExecution` 的名称。
3. **服务签名**（`proof.type = service_ed25519`）：server 用服务签名密钥（Ed25519）签名。
   - 签名输入是 ASCII `srenautix-approval-v1` 加换行符，再接 `JCS(statement)`。statement 为 `{"assertion": 断言}`；H 档时为 `{"assertion": 断言, "reauth": 重新认证凭据}`。
   - 重新认证凭据含 `method`（`oidc_max_age` 或 `local_totp`）、`auth_time` 与会话 ID 的哈希。gateway 要求 `auth_time` 不晚于 `issued_at`，且两者相差不超过 300 秒。
   - 公钥带 `key_id`，可设 `not_after`：只接受 `issued_at` 早于它的断言，用于轮换。
4. **通行密钥签名**（`proof.type = webauthn_ed25519`，合规配置的 H 档）：审批人的 WebAuthn 凭据（COSE alg -8）签名。
   - `clientDataJSON.challenge` 是 `sha256(JCS(断言))` 原始 32 字节的 base64url，`type` 为 `webauthn.get`，`origin` 必须在白名单中。
   - `authenticatorData` 的 rpIdHash 等于 `sha256(rp_id)`，UP 与 UV 标志都必须置位。
   - 签名覆盖 `authenticatorData ‖ sha256(clientDataJSON)`；凭据登记的 `principal` 必须等于断言的 `approver_principal`。
   - 合规配置下，H 档断言只接受这种证明。
5. **gateway 的校验顺序**：
   1. 信封符合 schema；
   2. 签名（上面第 3 或第 4 条）；
   3. 绑定：`proposal_id`、`action`、`params_hash`（由工单中的参数重新计算）、`target_uid`、`cluster`、`incident_version`、`root_component`、`evidence_fingerprint` 逐项等于工单；
   4. 时效：`expires_at` 晚于 `issued_at`；`issued_at` 不超前 gateway 时间 5 秒以上；审批未过期；提议 TTL 未过；`issued_at` 晚于中心给出的恢复标记（DESIGN §15.3）；
   5. 策略：动作已启用、目标命名空间在允许范围内；审批人作用域覆盖目标所在的命名空间且 `max_tier` 不低于断言档位；断言的等级等于 gateway 执行前重新核对的等级；档位不低于该等级、自身依赖与爆炸半径要求的最低档位；自动执行只限策略允许的动作、命名空间、规则与每小时上限。
   任何一步失败，执行记录进入 `rejected`、`expired` 或 `stale`，原因码写在 `status.reason` 中，并推回中心。
6. **黄金向量**：`contract/gateway/v1/testvectors/approval-vectors.json` 由 `hack/gen-gateway-vectors` 用固定种子生成，包含规范化、参数哈希、两种签名、篡改每个字段、每个绑定字段不一致、每个时效与签名原因码的用例。Go 的 `internal/spoke/gateway/assertion` 与 TS 侧都必须对每个用例给出相同的原因码。

## 结果

- 断言的哈希只取决于内容，与字段顺序、空白、数字写法无关；两种语言用同一组向量互相约束。
- 标准配置下，server 被攻破时攻击者可以签出 L 档断言；H 档还需要 5 分钟内的重新认证凭据。合规配置用通行密钥签名消除这个缺口（DESIGN §9.2）。
- 执行后校验的条件随参数一起被审批，中心无法在审批之后改动它们。
