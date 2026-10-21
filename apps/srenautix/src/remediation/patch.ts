import { structuredPatch } from 'diff';

/**
 * 一个文件的 git diff 格式补丁（带 diff --git 头），作为 gitops_pr 的 params.patch：
 * before 为 null 时是新文件（new file mode 100644、--- /dev/null），gateway 的补丁解析与 git apply 都按新建处理。
 */
export function filePatch(path: string, before: string | null, after: string): string {
  const p = structuredPatch(before === null ? '/dev/null' : `a/${path}`, `b/${path}`, before ?? '', after, '', '', {
    context: 3,
  });
  const lines = [
    `diff --git a/${path} b/${path}`,
    ...(before === null ? ['new file mode 100644'] : []),
    `--- ${before === null ? '/dev/null' : `a/${path}`}`,
    `+++ b/${path}`,
  ];
  for (const h of p.hunks) {
    // 一侧没有行时，unified diff 的起始行号是插入或删除位置之前的那一行（新文件是 -0,0），与 git 和 jsdiff 的 formatPatch 相同
    const oldStart = h.oldLines === 0 ? h.oldStart - 1 : h.oldStart;
    const newStart = h.newLines === 0 ? h.newStart - 1 : h.newStart;
    lines.push(`@@ -${oldStart},${h.oldLines} +${newStart},${h.newLines} @@`, ...h.lines);
  }
  return `${lines.join('\n')}\n`;
}
