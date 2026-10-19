# 0081 唯一出口、脱敏与蜜标

## 背景

DESIGN §8.4 要求所有发往模型服务的请求经过同一个模块，按卡片的出境控制脱敏，CI 用语料证明凭证与个人信息不会进入提示词，运行时命中蜜标立即停止出站；国内配置默认禁止出境路由。

## 决定

1. **唯一出口**：`apps/srenautix/src/llm/egress.ts` 是唯一构造模型客户端的模块。客户端的 `fetch` 被替换为受控实现：请求地址必须与路由的 base URL 同源；每个请求体在发出前检查蜜标与残留凭证；出站字节按调用计量。单元测试扫描源码，其他模块出现 `new OpenAI(` 或默认导入 `openai` 时失败；worker 的代码不允许出现读取 ConfigMap 或 Secret 的调用。
2. **片段级出境控制**：提示词由片段组成，每个片段带数据类别（metrics、logs、traces、events、topology、changes、alerts、knowledge）与 `egress`。`egress: never` 的证据卡不生成片段；`redact` 的片段与模型自己的历史输出在出站前脱敏；固定指令与目录为 `allow`。
3. **脱敏规则**（按顺序）：PEM 私钥块、JWT、带口令的 DSN、`Bearer`/`Basic` 凭据、各云的访问密钥前缀（AWS、阿里云、腾讯云、火山引擎、Google）、常见 API token 前缀、键名在前的键值对（`password=`、`aws_secret_access_key=`、`AccessKeySecret:` 等）、身份证号（GB 11643 校验位）、银行卡号（发卡行号段加 Luhn 校验）、手机号。校验位不通过的长数字保留，避免误伤时间戳与 ID。只读工具返回的 Kubernetes 对象另外剔除 `env[].value` 字面值。规则集的哈希作为 `redaction_version` 写入研判清单。
4. **出站前最后检查**：请求体里仍出现 PEM、JWT、云访问密钥或 API token 时请求不发出（这些只可能来自 `allow` 片段，说明出境控制有缺口）。
5. **蜜标**：配置的蜜标（至少 16 个字符，且不能被脱敏规则命中）出现在任何请求体中时，立即停止全部出站并置 `srenautix_egress_halted`，之后每次研判都只出阶段 A，直到人工处理后重启 worker。
6. **出境路由**：`in_domain: false` 的路由在 `allow_cross_border: false`（默认）时构造客户端即失败，请求时再检查一次。
7. **记录**：`worker.llm_calls` 只保存脱敏后的请求体与模型输出，并记录每类规则的命中次数与数据类别；研判清单的出境清单列出每次请求的路由、是否境内、数据类别、命中次数与字节数。worker 不保存原始提示词。

## 结果

- CI 语料（`test/fixtures/redaction/corpus.json`）把每个样本植入 5 种载体（纯文本、logfmt、Pod JSON、中文句子、日志行），断言脱敏后不再出现，并断言一组正常文本原样保留。语料中的凭证样本按片段存放、测试时拼接，避免仓库的密钥扫描把夹具当成泄露。
- 控制台的"原始提示词"接口在 worker 上返回 404：原文从不落盘。
