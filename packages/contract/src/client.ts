import createClient, { type ClientOptions } from 'openapi-fetch';
import type { paths } from './generated/openapi.js';

/** 中心 HTTP API 的类型化客户端（openapi-fetch），控制台、Grafana 插件与测试共用 */
export function createHubClient(options: ClientOptions) {
  return createClient<paths>(options);
}
