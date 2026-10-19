// 手动调试用：启动与 e2e 相同的真实后端并保持运行，Ctrl-C 停止。
//   SRENAUTIX_ENVTEST_DIR=<envtest 目录> node --conditions=@srenautix/source --import tsx e2e/run-hub.ts

import { startHub } from './hub';

const hub = await startHub();
console.log(JSON.stringify(hub.state, null, 2));
const stop = () => {
  void hub.stop().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
