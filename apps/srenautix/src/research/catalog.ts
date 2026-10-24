// 区分性检查的目录（事件研判与主动优化共用，ADR 0146 §2.7）

/** 区分性检查可用的查询模板（领域包 signals.yaml 的 templates，以及卡片检查） */
export interface CheckTemplate {
  id: string;
  description: string;
  /** 参数的 JSON Schema（可移植子集） */
  args: Record<string, unknown>;
}

/** 区分性检查可用的只读工具 */
export interface CheckTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
