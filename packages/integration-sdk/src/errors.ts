// 集成调用的错误类型。

/** 后端返回错误、超时或连接失败；timeout 为 true 表示请求在超时之前没有得到响应 */
export class DatasourceError extends Error {
  constructor(
    readonly integration: string,
    detail: string,
    readonly timeout = false,
  ) {
    super(`${integration}：${detail}`);
    this.name = 'DatasourceError';
  }
}

/** 请求的时刻或区间超出回放时钟窗口（DESIGN §10.5、§14.3） */
export class ClockWindowViolation extends Error {
  constructor(detail: string) {
    super(`超出回放时钟窗口：${detail}`);
    this.name = 'ClockWindowViolation';
  }
}

/** 集成没有声明或没有通过 verify() 的能力 */
export class CapabilityUnavailable extends Error {
  constructor(
    readonly integration: string,
    readonly capability: string,
  ) {
    super(`${integration} 的能力 ${capability} 不可用`);
    this.name = 'CapabilityUnavailable';
  }
}
