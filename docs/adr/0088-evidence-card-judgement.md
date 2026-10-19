# 0088 证据卡判定：CEL 引擎、函数库、成本上界与无数据语义

## 背景

证据卡的判定由领域包用 CEL 声明（DESIGN §6.1），运行在 server 与 worker 的进程里。领域包可能来自第三方，表达式必须有确定的求值成本上界；判定还要区分"正常"和"没有数据所以无法判断"，没有样本时得出正常会让研判错过真正的根因。过滤型查询（"出错的序列""OOM 事件""错误日志行"）返回空集合恰恰是正常结果，与"指标不存在"不能混为一谈。

## 决定

1. **引擎**：使用 `@marcbachmann/cel-js`（纯 TypeScript、无运行时依赖、支持自定义函数与宏、标准 `cel.bind`）。CEL 的 `let` 是保留字，判定层用 `judge.let` 声明有序绑定，表达式内部的局部绑定用 `cel.bind`。
2. **函数库**：聚合 `max`、`min`、`last`、`sum`、`count`、`none`；序列 `points`、`any_point`（宏）、`transitions`、`top_share`、`join`、`ratio`、`first_above`、`first_below`；展示 `label`、`abs`、`fmt_*`。序列在 CEL 中是 `{labels, times, values}`。多条序列的 `last` 取各序列最后一个点中的最大值，结果与后端返回序列的顺序无关，Prometheus 与 VictoriaMetrics 因此得出相同结论。
3. **成本上界**：进入 CEL 之前把输入截断到每个引用 200 条序列、每条 1500 个点、日志 200 行；加载时按 AST 计算最坏情况下的求值步数（推导式按元素数相乘，单序列参数在推导式内部按点数计），超过 2000 万步的表达式拒绝加载。解析限制：AST 400 个节点、深度 40。
4. **判定顺序**：能力缺失 → `capability_missing`；所有 `no_data` 语义的引用都没有样本或报错 → 无法判定；按序求 `let`；`undeterminable_if`；`abnormal_if` 命中第一条 → 异常；都不命中时，有规则因缺数据无法求值、或有 `no_data` 引用缺数据或报错 → 无法判定（`partial_data`、`source_error`），否则正常。缺样本之外的求值错误 → `evaluation_error`。
5. **`empty_is`**：引用默认 `no_data`；`normal` 表示空集合是正常结果，用于过滤型查询。过滤型引用的指标在数据源中不存在时同样视为空集合（信号解析记录原因 `missing_metric`）。没有任何样本的卡片永远不会得出正常。
6. **文字**：`say` 是 ICU MessageFormat，中英两种语言，变量取自 `let`；`anomaly_started_at` 由同名 `let` 给出。

## 结果

- 第三方领域包的表达式成本在加载时就有上界，恶意或失误的表达式不会拖慢研判。
- `pack test` 为每张卡自动生成空后端、缺单个引用、引用报错三类测试，保证"没有数据不是正常"在每张卡上成立。
- `cel-js` 的版本固定，升级时由全部内置包的夹具测试回归。
