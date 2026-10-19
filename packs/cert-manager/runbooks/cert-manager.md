# cert-manager

## 证书即将到期或未就绪

1. `kubectl describe certificate <name>` 查看 Ready 条件的原因；再看对应的 CertificateRequest、Order、Challenge。
2. ACME HTTP-01：确认挑战路径能从公网访问（入口、DNS、防火墙）。
3. ACME DNS-01：确认 DNS 服务商凭证有效，TXT 记录已传播。
4. 已过续期时间点仍未续期：控制器出错或被限流，看 `签发错误` 卡。

## 签发错误

- ACME 返回 429：触发了 Let's Encrypt 的速率限制，等待窗口结束，并检查是否有证书在反复重新签发。
- 控制器同步错误持续增长：查看 cert-manager 控制器日志。
