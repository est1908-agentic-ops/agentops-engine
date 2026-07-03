import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['packages/policies/src/**/*.test.ts'],
      coverage: {
        provider: 'v8',
        include: ['packages/policies/src/**/*.ts'],
        exclude: ['packages/policies/src/**/*.test.ts', 'packages/policies/src/index.ts'],
        thresholds: {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
      },
    },
  }),
);
