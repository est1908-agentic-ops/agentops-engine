import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { workflow: 'src/workflow.ts', worker: 'src/worker.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  // Self-contained: bundle the used bits of contracts/policies. Keep Temporal
  // external — it is a peer dep provided by the consumer's worker.
  noExternal: [/@agentops\//],
  external: [/@temporalio\//],
});
