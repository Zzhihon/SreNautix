// 手动调试用：启动与插件 e2e 相同的环境（需要先构建插件）并保持运行，Ctrl-C 停止。
//   SRENAUTIX_ENVTEST_DIR=<envtest 目录> node --conditions=@srenautix/source --import tsx e2e/run-stack.ts

import { startGrafanaStack } from './grafana.ts';

const stack = await startGrafanaStack();
console.log(JSON.stringify(stack.state, null, 2));
const stop = () => {
  void stack.stop().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
