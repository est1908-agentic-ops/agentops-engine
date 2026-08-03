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

// AGENTS.md rule 4 (ports, not vendors): forge/tracker SDKs may only be imported inside
// packages/ports/src. Shared lists so blocks that must combine bans (see workflows below) don't
// drift. NOTE: rule 4 also forbids "call their APIs" (raw fetch/GraphQL to a forge/tracker host)
// and, outside backends/, "spawn an agent CLI". Neither is lint-enforced: both are runtime-string
// concerns that would false-positive on the legitimate raw-GraphQL Linear facade inside ports/
// and the node:child_process command runners inside activities/. They remain review-time rules.
const forgeTrackerSdkPaths = [
  { name: 'octokit', message: 'Forge SDKs belong in packages/ports — AGENTS.md rule 4.' },
  { name: '@linear/sdk', message: 'Tracker SDKs belong in packages/ports — AGENTS.md rule 4.' },
  { name: 'jira-client', message: 'Tracker SDKs belong in packages/ports — AGENTS.md rule 4.' },
  { name: 'jira.js', message: 'Tracker SDKs belong in packages/ports — AGENTS.md rule 4.' },
  { name: 'bitbucket', message: 'Forge SDKs belong in packages/ports — AGENTS.md rule 4.' },
];
const forgeTrackerSdkPatterns = [
  { group: ['@octokit/*', '@gitbeaker/*'],
    message: 'Forge/tracker SDKs belong in packages/ports — AGENTS.md rule 4.' },
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
      'no-restricted-imports': ['error', { paths: forgeTrackerSdkPaths, patterns: forgeTrackerSdkPatterns }],
    },
  },
  {
    // AGENTS.md rule 4: packages/ports IS the sanctioned home for forge/tracker SDKs
    // (build-github-ports.ts imports @octokit/*). This is the single exemption to the repo-wide ban.
    files: ['packages/ports/src/**'],
    rules: { 'no-restricted-imports': 'off' },
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
      // Flat-config REPLACES (not merges) no-restricted-imports per matching block, so we must restate
      // the repo-wide rule-4 SDK ban alongside rule 1's http-client ban here or workflows loses one.
      'no-restricted-imports': ['error', {
        paths: [...httpClientImports, ...forgeTrackerSdkPaths],
        patterns: forgeTrackerSdkPatterns,
      }],
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
