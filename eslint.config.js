const { defineConfig } = require('eslint/config');
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const importPlugin = require('eslint-plugin-import');
const reactHooks = require('eslint-plugin-react-hooks');

// AGENTS.md rule 1 (determinism boundary): shared rule lists to prevent drift between blocks
const determinismGlobals = [
  { name: 'Date', message: 'Non-deterministic in workflow code — AGENTS.md rule 1.' },
  { name: 'setTimeout', message: 'Use Temporal sleep() instead — AGENTS.md rule 1.' },
  { name: 'setInterval', message: 'Non-deterministic in workflow code — AGENTS.md rule 1.' },
  { name: 'fetch', message: 'Use Temporal activities for I/O — AGENTS.md rule 1.' },
  { name: 'crypto', message: 'Non-deterministic in workflow code — AGENTS.md rule 1.' },
];

const determinismProperties = [
  { object: 'Math', property: 'random', message: 'Non-deterministic in workflow code — AGENTS.md rule 1.' },
  { object: 'Date', property: 'now', message: 'Non-deterministic in workflow code — AGENTS.md rule 1.' },
  { object: 'crypto', property: 'randomUUID', message: 'Non-deterministic in workflow code — AGENTS.md rule 1.' },
  { object: 'crypto', property: 'getRandomValues', message: 'Non-deterministic in workflow code — AGENTS.md rule 1.' },
];

const httpClientImports = [
  { name: 'axios', message: 'Use Temporal activities for I/O — AGENTS.md rule 1.' },
  { name: 'node-fetch', message: 'Use Temporal activities for I/O — AGENTS.md rule 1.' },
  { name: 'undici', message: 'Use Temporal activities for I/O — AGENTS.md rule 1.' },
  { name: 'got', message: 'Use Temporal activities for I/O — AGENTS.md rule 1.' },
  { name: 'superagent', message: 'Use Temporal activities for I/O — AGENTS.md rule 1.' },
  { name: 'request', message: 'Use Temporal activities for I/O — AGENTS.md rule 1.' },
];

module.exports = defineConfig(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { import: importPlugin },
    settings: {
      'import/resolver': {
        typescript: { alwaysTryTypes: true },
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './packages/workflows/src',
              from: ['./packages/activities/src', './packages/ports/src', './packages/backends/src'],
              message:
                'AGENTS.md rule 1 (determinism boundary): packages/workflows may not import activities/ports/backends. All side effects go through proxied activities.',
            },
            {
              target: './packages/policies/src',
              from: [
                './packages/activities/src',
                './packages/ports/src',
                './packages/backends/src',
                './packages/workflows/src',
              ],
              message: 'AGENTS.md rule 2: packages/policies stays pure — no Temporal, no I/O.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/ui/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ['packages/workflows/src/**/!(*.test).ts'],
    rules: {
      // AGENTS.md rule 1 (determinism boundary): no Node core imports. The `allow` array is the
      // reviewed escape hatch for a proven-safe deterministic built-in (e.g. node:path), added
      // only after verification that it does not break Temporal's replay determinism.
      'import/no-nodejs-modules': ['error', { allow: [] }],
      'no-restricted-globals': ['error', ...determinismGlobals],
      'no-restricted-properties': ['error', ...determinismProperties],
      'no-restricted-imports': [
        'error',
        ...httpClientImports,
      ],
    },
  },
  {
    files: ['packages/workflows/src/**/*.test.ts'],
    rules: {
      'no-restricted-globals': ['error', ...determinismGlobals],
      'no-restricted-properties': ['error', ...determinismProperties],
    },
  },
  {
    files: ['packages/policies/src/**/*.ts'],
    rules: {
      // AGENTS.md rule 2: packages/policies stays pure — no Temporal imports, no I/O.
      // The `allow` array is the reviewed escape hatch for a proven-safe built-in, mirroring
      // the workflows block; empty today because policies imports only @agentops/contracts.
      'import/no-nodejs-modules': ['error', { allow: [] }],
      'no-restricted-imports': [
        'error',
        {
          paths: [...httpClientImports],
          patterns: [
            {
              group: ['@temporalio/*'],
              message:
                'AGENTS.md rule 2: packages/policies stays pure — no Temporal imports.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['eslint.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
