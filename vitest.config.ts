import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@agentops/contracts': path.resolve(__dirname, 'packages/contracts/src/index.ts'),
      '@agentops/policies': path.resolve(__dirname, 'packages/policies/src/index.ts'),
      '@agentops/ports': path.resolve(__dirname, 'packages/ports/src/index.ts'),
      '@agentops/backends': path.resolve(__dirname, 'packages/backends/src/index.ts'),
      '@agentops/activities': path.resolve(__dirname, 'packages/activities/src/index.ts'),
      '@agentops/workflows': path.resolve(__dirname, 'packages/workflows/src/index.ts'),
    },
  },
});
