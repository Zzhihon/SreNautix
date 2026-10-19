// 判定过程中的两类可预期失败：引用没有样本、引用的数据源报错。
// 其余异常（类型错误、库内部错误）都按求值错误处理。

export class NoSamplesError extends Error {
  constructor(what: string) {
    super(`${what} 没有样本`);
    this.name = 'NoSamplesError';
  }
}

export class SourceError extends Error {
  constructor(
    readonly ref: string,
    readonly detail: string,
  ) {
    super(`引用 ${ref} 的数据源报错：${detail}`);
    this.name = 'SourceError';
  }
}

export class CapabilityMissingError extends Error {
  constructor(
    readonly ref: string,
    readonly capability: string,
  ) {
    super(`引用 ${ref} 需要的能力 ${capability} 不可用`);
    this.name = 'CapabilityMissingError';
  }
}

/** 卡片或表达式在加载时校验不通过 */
export class PackLintError extends Error {
  constructor(
    readonly where: string,
    detail: string,
  ) {
    super(`${where}：${detail}`);
    this.name = 'PackLintError';
  }
}
