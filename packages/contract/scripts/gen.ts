// 从 contract/ 生成 TS 类型与内嵌 schema。带 --check 时只比较，不一致就以非零退出，供 CI 使用。
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile, type JSONSchema } from 'json-schema-to-typescript';
import openapiTS, { astToString } from 'openapi-typescript';
import { format } from 'prettier';

const here = dirname(fileURLToPath(import.meta.url));
const contractDir = resolve(here, '../../../contract');
const outDir = resolve(here, '../src/generated');
const check = process.argv.includes('--check');

const BANNER = '// 本文件由 packages/contract/scripts/gen.ts 从 contract/ 生成，不要手工修改。\n';

function schemaFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        return schemaFiles(p);
      }
      return name.endsWith('.schema.json') ? [p] : [];
    });
}

interface SchemaFile {
  path: string;
  rel: string;
  json: Record<string, unknown> & { $id: string; title: string; $defs?: Record<string, { title?: string }> };
}

function load(path: string): SchemaFile {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof json.$id !== 'string' || typeof json.title !== 'string') {
    throw new Error(`${path}: 缺少 $id 或 title`);
  }
  const rel = relative(contractDir, path);
  const expectedId = `https://srenautix.io/contract/${rel}`;
  if (json.$id !== expectedId) {
    throw new Error(`${path}: $id 应为 ${expectedId}，实际为 ${json.$id}`);
  }
  return { path, rel, json };
}

const pascal = (s: string) => s.replace(/(^|[-_])([a-z])/g, (_, __, c: string) => c.toUpperCase());

// 没有 title 的 $defs 以 <文件 title><定义名> 命名，避免不同文件的同名定义冲突。只改生成时读入的副本
function withDefTitles(f: SchemaFile): SchemaFile['json'] {
  const defs = Object.fromEntries(
    Object.entries(f.json.$defs ?? {}).map(([name, def]) => [
      name,
      def.title === undefined ? { ...def, title: f.json.title + pascal(name) } : def,
    ]),
  );
  return f.json.$defs === undefined ? f.json : { ...f.json, $defs: defs };
}

// 有顶层实例定义的文件（type、oneOf、allOf 之一）
function describesInstance(json: Record<string, unknown>): boolean {
  return 'type' in json || 'oneOf' in json || 'allOf' in json || 'const' in json;
}

async function genTypes(files: SchemaFile[]): Promise<string> {
  // 用一个合成的根 schema 引用所有文件与所有 $defs，一次编译，跨文件引用的类型只声明一次
  const properties: Record<string, JSONSchema> = {};
  const seen = new Map<string, string>();
  const add = (title: string, ref: string) => {
    const prev = seen.get(title);
    if (prev !== undefined) {
      throw new Error(`类型名 ${title} 重复：${prev} 与 ${ref}`);
    }
    seen.set(title, ref);
    properties[title] = { $ref: ref };
  };
  const titled = new Map(files.map((f) => [f.path, withDefTitles(f)]));
  for (const f of files) {
    const json = titled.get(f.path)!;
    if (describesInstance(json)) {
      add(json.title, `./${f.rel}`);
    }
    for (const [name, def] of Object.entries(json.$defs ?? {})) {
      add(def.title!, `./${f.rel}#/$defs/${name}`);
    }
  }
  const root: JSONSchema = {
    title: 'SrenautixContractIndex',
    type: 'object',
    additionalProperties: false,
    properties,
  };
  const ts = await compile(root, 'SrenautixContractIndex', {
    cwd: contractDir,
    $refOptions: {
      resolve: {
        file: {
          read: (file: { url: string }) => {
            const json = titled.get(fileURLToPath(new URL(file.url, 'file://')));
            if (json === undefined) {
              throw new Error(`引用了 contract/ 之外或不存在的文件：${file.url}`);
            }
            return JSON.stringify(json);
          },
        },
      },
    },
    bannerComment: '',
    additionalProperties: false,
    unreachableDefinitions: false,
    strictIndexSignatures: true,
    // 有界数组生成普通数组类型，长度上限由运行时校验负责
    maxItems: -1,
    format: false,
  });
  return BANNER + ts;
}

async function genOpenapi(): Promise<string> {
  const ast = await openapiTS(pathToFileURL(join(contractDir, 'openapi.yaml')), {
    alphabetize: true,
    exportType: true,
  });
  return BANNER + astToString(ast);
}

function genSchemas(files: SchemaFile[]): string {
  const entries = files.map((f) => `  ${JSON.stringify(f.json.$id)}: ${JSON.stringify(f.json)},`).join('\n');
  const version = readFileSync(join(contractDir, 'VERSION'), 'utf8').trim();
  return (
    BANNER +
    `export const CONTRACT_VERSION = ${JSON.stringify(version)};\n\n` +
    `export const SCHEMAS: Record<string, Record<string, unknown>> = {\n${entries}\n};\n`
  );
}

async function pretty(source: string): Promise<string> {
  return format(source, { parser: 'typescript', printWidth: 120, singleQuote: true, trailingComma: 'all' });
}

async function main(): Promise<void> {
  const files = schemaFiles(contractDir).map(load);
  const outputs: Record<string, string> = {
    'types.ts': await pretty(await genTypes(files)),
    'openapi.ts': await pretty(await genOpenapi()),
    'schemas.ts': await pretty(genSchemas(files)),
  };
  if (check) {
    const stale = Object.entries(outputs)
      .filter(([name, text]) => {
        const p = join(outDir, name);
        return !existsSync(p) || readFileSync(p, 'utf8') !== text;
      })
      .map(([name]) => name);
    if (stale.length > 0) {
      console.error(`生成结果与仓库不一致：${stale.join(', ')}。运行 pnpm contract:gen 后提交。`);
      process.exit(1);
    }
    console.log(`生成结果与仓库一致（${files.length} 个 schema 文件）`);
    return;
  }
  mkdirSync(outDir, { recursive: true });
  for (const [name, text] of Object.entries(outputs)) {
    writeFileSync(join(outDir, name), text);
  }
  console.log(`已生成 ${Object.keys(outputs).join(', ')}（${files.length} 个 schema 文件）`);
}

await main();
