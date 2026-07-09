import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Every e2e file spins up its own embedded Temporal test-server process
    // (TestWorkflowEnvironment.createTimeSkipping()) -- real subprocesses, not
    // lightweight unit-test fixtures. Vitest's default file-level parallelism
    // runs several of these concurrently, which is fine on a many-core dev
    // machine but overwhelms the small self-hosted CI runners, intermittently
    // pushing startup past the timeouts above. Serialize file execution so
    // heavy server startups never overlap; costs wall-clock time, buys
    // reliability where it's actually scarce (CI).
    fileParallelism: false,
  },
});
