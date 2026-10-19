# 渲染黄金用例

每个 JSON 文件是一条语言无关的渲染用例，由 `test/unit/notify-render.test.ts` 对 Telegram 渲染（以及 `channels` 中列出的其他渠道）逐个执行。

| 字段                               | 含义                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `kind`                             | `incident`（事件消息，`input` 是 `DesiredIncidentMessage`）或 `digest`（风暴汇总，`input` 是 `DigestInput`） |
| `chat`                             | 渠道目标：`chat`、`language`                                                                                 |
| `results`                          | 消息“最近操作”中的按钮操作结果                                                                               |
| `storm`                            | 所属风暴的开始时间，没有时为 null                                                                            |
| `prefix`                           | 汇总消息的前缀                                                                                               |
| `expect.contains` / `not_contains` | 文本中必须出现 / 不得出现的片段                                                                              |
| `expect.order`                     | 必须按顺序出现的片段                                                                                         |
| `expect.starts_with`               | 文本开头                                                                                                     |
| `expect.buttons`                   | Telegram 键盘按行的按钮文字                                                                                  |
| `expect.url_buttons`               | URL 按钮的个数                                                                                               |
| `expect.entities`                  | 必须存在的实体（类型与覆盖的文字）                                                                           |
| `expect.max_units`                 | 文本 UTF-16 长度上限                                                                                         |
| `expect.feishu_buttons`            | 飞书卡片中按顺序出现的按钮文字                                                                               |

字符串值可以写成 `{"$repeat": "片段", "times": N}`，加载时展开为重复 N 次的文本，用来构造超长内容。时间一律为 RFC 3339 UTC。
