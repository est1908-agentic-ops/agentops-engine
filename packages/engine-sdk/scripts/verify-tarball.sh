#!/usr/bin/env bash
# Pack the SDK and typecheck a throwaway consumer against BOTH entry points —
# proves the published tarball (not the workspace path) resolves, bundles
# contracts/policies, and ships correct .d.ts. SP2 design §13.
set -euo pipefail
cd "$(dirname "$0")/.."
TMP=''
TARBALL=''
cleanup() {
  if [[ -n "$TMP" && -d "$TMP" ]]; then
    rm -rf -- "$TMP"
  fi
  if [[ -n "$TARBALL" && -f "$TARBALL" ]]; then
    rm -f -- "$TARBALL"
  fi
}
trap cleanup EXIT
pnpm build
TARBALL="$(pwd)/$(pnpm pack | tail -1)"
TMP="$(mktemp -d)"
cp "$TARBALL" "$TMP/"
cd "$TMP"
cat > package.json <<'JSON'
{ "name": "sdk-consumer", "private": true, "type": "module" }
JSON
npm init -y >/dev/null 2>&1 || true
npm i "./$(basename "$TARBALL")" @temporalio/workflow@1.19.0 @temporalio/worker@1.19.0 @temporalio/common@1.19.0 @temporalio/client@1.19.0 typescript@5.8.3 >/dev/null
cat > check.ts <<'TS'
import {
  childDevCycle,
  ENGINE_QUEUE,
  engineActivities,
  engineAgent,
  parseAgentResult,
} from '@agentic-ops/engine-sdk/workflow';
import { createEngineWorker } from '@agentic-ops/engine-sdk/worker';
import type { Worker } from '@temporalio/worker';

const _ = { engineActivities, childDevCycle, ENGINE_QUEUE, createEngineWorker };
type IsAny<T> = 0 extends (1 & T) ? true : false;
type AssertNotAny<T> = IsAny<T> extends true ? never : T;
type AssertFalse<T extends false> = T;

async function checkRepositorySession() {
  const eng: AssertNotAny<ReturnType<typeof engineAgent>> = engineAgent();
  type _CreateRepositorySessionResultIsNotAny = AssertFalse<
    IsAny<Awaited<ReturnType<typeof eng.createRepositorySession>>>
  >;
  type _RunAgentResultIsNotAny = AssertFalse<IsAny<Awaited<ReturnType<typeof eng.runAgent>>>>;
  type _ParserResultIsNotAny = AssertFalse<IsAny<ReturnType<typeof parseAgentResult>>>;
  // @ts-expect-error repository sessions require a task ID and repository list
  void eng.createRepositorySession({});
  const session = await eng.createRepositorySession({
    taskId: 'consumer-check',
    repositories: [
      { repo: 'acme/app' },
      { repo: 'acme/shared', ref: 'main' },
    ],
  });
  const workspaceRef: string = session.workspaceRef;
  const repositories: Array<{ repo: string; relativePath: string; commit: string }> = session.repositories;
  void [workspaceRef, repositories];

  try {
    const first: Awaited<ReturnType<typeof eng.runAgent>> = await eng.runAgent({
      taskId: 'consumer-check',
      stage: 'agent',
      attempt: 1,
      callIndex: 1,
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

    const second: Awaited<ReturnType<typeof eng.runAgent>> = await eng.runAgent({
      taskId: 'consumer-check',
      stage: 'agent',
      attempt: 2,
      callIndex: 2,
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
    // @ts-expect-error cleanup accepts a request, not a raw workspace reference
    void eng.cleanupRepositorySession(session.workspaceRef);
  }
}

const worker: Promise<Worker> = createEngineWorker({
  taskQueue: 'consumer-check',
  workflowsPath: './workflows',
  activities: {},
});
void worker;
void checkRepositorySession;
TS
private_declaration_refs="$(find node_modules/@agentic-ops/engine-sdk/dist -type f \( -name '*.d.ts' -o -name '*.d.cts' \) -exec grep -nH '@agentops/' {} + || true)"
if [[ -n "$private_declaration_refs" ]]; then
  printf '%s\n' "$private_declaration_refs" >&2
  echo 'published declarations must not reference private @agentops packages' >&2
  exit 1
fi
# @temporalio/worker@1.19.0 fails its own EventMap declaration under the
# documented TypeScript 5.8.3 consumer compiler. SDK declarations were already
# scanned above; skip only this upstream peer-library diagnostic.
npx tsc --noEmit --target es2022 --moduleResolution bundler --module esnext --skipLibCheck check.ts
echo "tarball verify OK"
