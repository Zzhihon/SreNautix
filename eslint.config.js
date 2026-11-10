import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.scratch/**',
      '**/src/generated/**',
      // integration-sdk 构建时从 Go 工具链复制的 wasm 运行胶水
      'packages/integration-sdk/wasm/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message: '使用字面量联合类型，便于与 JSON Schema 契约互通',
        },
      ],
    },
  },
  // 服务端的内核（apps/srenautix/src/kernel）是最底层：日志、指标、HTTP、选主、状态库。它不能导入内核之外的任何模块，
  // 否则业务模块与内核会互相依赖。内核根目录的文件不能用 ../，kernel/store 的文件不能用 ../../
  {
    files: ['apps/srenautix/src/kernel/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['../*'], message: '内核不能导入内核之外的模块（apps/srenautix/src/kernel）' }] },
      ],
    },
  },
  {
    files: ['apps/srenautix/src/kernel/*/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['../../*'], message: '内核不能导入内核之外的模块（apps/srenautix/src/kernel）' }] },
      ],
    },
  },
);
