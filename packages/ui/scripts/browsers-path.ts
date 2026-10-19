import { resolve } from 'node:path';

/** 仓库根目录下的 .scratch/ms-playwright（绝对路径）。安装脚本与各包的测试配置都从这里取。 */
export const BROWSERS_PATH = resolve(import.meta.dirname, '../../../.scratch/ms-playwright');
