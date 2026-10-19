// 一致性测试的结果：每项检查一个条目。测试框架无关，调用方用自己的断言判断 passed。

export interface ConformanceCheck {
  id: string;
  title: string;
  ok: boolean;
  detail: string;
}

export interface ConformanceReport {
  kind: string;
  subject: string;
  checks: ConformanceCheck[];
  passed: boolean;
}

export class Checks {
  readonly list: ConformanceCheck[] = [];

  constructor(
    readonly kind: string,
    readonly subject: string,
  ) {}

  /** 执行一项检查：返回描述即通过，抛错即失败 */
  async run(id: string, title: string, f: () => Promise<string> | string): Promise<void> {
    try {
      this.list.push({ id, title, ok: true, detail: await f() });
    } catch (err) {
      this.list.push({
        id,
        title,
        ok: false,
        detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  }

  report(): ConformanceReport {
    return { kind: this.kind, subject: this.subject, checks: this.list, passed: this.list.every((c) => c.ok) };
  }
}

export function expectEq<T>(what: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${what}：期望 ${e}，实际 ${a}`);
  }
}

/** 断言异步调用以指定类型的错误失败 */
export async function expectReject(what: string, f: () => Promise<unknown>, errorName: string): Promise<string> {
  try {
    await f();
  } catch (err) {
    const name = err instanceof Error ? err.name : typeof err;
    if (name !== errorName) {
      throw new Error(`${what}：期望 ${errorName}，实际 ${name}：${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    return `${errorName}：${(err as Error).message}`;
  }
  throw new Error(`${what}：期望 ${errorName}，实际成功返回`);
}
