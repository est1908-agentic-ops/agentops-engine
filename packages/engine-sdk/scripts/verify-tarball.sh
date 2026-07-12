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
import { engineActivities, childDevCycle, ENGINE_QUEUE } from '@agentops/engine-sdk/workflow';
import { createEngineWorker } from '@agentops/engine-sdk/worker';
const _ = { engineActivities, childDevCycle, ENGINE_QUEUE, createEngineWorker };
TS
npx tsc --noEmit --moduleResolution bundler --module esnext --skipLibCheck check.ts
echo "tarball verify OK"
