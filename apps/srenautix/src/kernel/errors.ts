/** 接口错误：status 为 HTTP 状态码，code 为机器可读的错误码（契约 Error.error）。 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string) => new HttpError(400, 'bad_request', msg);
export const unauthorized = (msg = '缺少或未知的凭据') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg: string) => new HttpError(403, 'forbidden', msg);
export const notFound = (msg: string) => new HttpError(404, 'not_found', msg);
export const conflict = (code: string, msg: string) => new HttpError(409, code, msg);
export const unavailable = (msg: string) => new HttpError(503, 'unavailable', msg);
