/** PG 连接类错误（库不可达、连接被断开、连接超时）；其余错误（约束、语法）按缺陷处理。 */
export function isConnectionError(e: unknown): boolean {
  if (!(e instanceof Error)) {
    return false;
  }
  const code = (e as { code?: string }).code;
  if (
    code &&
    [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENOTFOUND',
      'EPIPE',
      '57P01',
      '57P02',
      '57P03',
      '08000',
      '08003',
      '08006',
      '08001',
      '08004',
    ].includes(code)
  ) {
    return true;
  }
  return /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error|connect ECONNREFUSED/i.test(
    e.message,
  );
}
