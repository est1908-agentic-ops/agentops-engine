#!/usr/bin/env bash
# Pack the SDK and typecheck a throwaway consumer against BOTH entry points —
# proves the published tarball (not the workspace path) resolves, bundles
# contracts/policies, and ships correct .d.ts. SP2 design §13.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm build
TARBALL="$(pnpm pack | tail -1)"
TMP="$(mktemp -d)"
cp "$TARBALL" "$TMP/"
cd "$TMP"
cat > package.json <<'JSON'
{ "name": "sdk-consumer", "private": true, "type": "module" }
JSON
npm init -y >/dev/null 2>&1 || true
npm i "./$(basename "$TARBALL")" @temporalio/workflow @temporalio/worker @temporalio/common @temporalio/client typescript >/dev/null
cat > check.ts <<'TS'
import {
  childDevCycle,
  ENGINE_QUEUE,
  engineActivities,
  engineAgent,
  parseAgentResult,
} from '@agentic-ops/engine-sdk/workflow';
import { createEngineWorker } from '@agentic-ops/engine-sdk/worker';

const _ = { engineActivities, childDevCycle, ENGINE_QUEUE, createEngineWorker };

async function checkRepositorySession() {
  const eng = engineAgent();
  const session = await eng.createRepositorySession({
    taskId: 'consumer-check',
    repositories: [
      { repo: 'acme/app' },
      { repo: 'acme/shared', ref: 'main' },
    ],
  });

  try {
    const first = await eng.runAgent({
      taskId: 'consumer-check',
      stage: 'agent',
      attempt: 1,
      promptRef: 'generic-task.md',
      promptContext: {
        taskId: 'consumer-check',
        instructions: 'Inspect the application repository.',
        outputContract: '{"status":"string"}',
      },
      workspaceRef: session.workspaceRef,
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
      backend: 'stub',
      model: 'consumer-check',
    });
    const firstResult = parseAgentResult(first.output);

    const second = await eng.runAgent({
      taskId: 'consumer-check',
      stage: 'agent',
      attempt: 2,
      promptRef: 'generic-task.md',
      promptContext: {
        taskId: 'consumer-check',
        instructions: 'Inspect the shared repository after the first result.',
        outputContract: '{"status":"string"}',
      },
      workspaceRef: session.workspaceRef,
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
      backend: 'stub',
      model: 'consumer-check',
    });
    const secondResult = parseAgentResult(second.output);
    void [firstResult, secondResult];
  } finally {
    await eng.cleanupRepositorySession({ workspaceRef: session.workspaceRef });
  }
}

void checkRepositorySession;
TS
npx tsc --noEmit --moduleResolution bundler --module esnext --skipLibCheck check.ts
echo "tarball verify OK"
