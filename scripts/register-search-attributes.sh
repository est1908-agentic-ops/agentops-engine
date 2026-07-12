#!/usr/bin/env bash
# MANUAL FALLBACK. The engine worker now auto-registers these at startup
# (packages/worker/src/ensure-search-attributes.ts), so you normally never run
# this. Kept for bootstrapping a namespace by hand or debugging.
# Register the custom Temporal search attributes the reconciler/Schedule/
# continuous-start stamp (SP2 design §7). Idempotent: "already exists" is fine.
# Usage: TEMPORAL_ADDRESS=... TEMPORAL_NAMESPACE=... ./scripts/register-search-attributes.sh
set -euo pipefail
NS="${TEMPORAL_NAMESPACE:?set TEMPORAL_NAMESPACE}"
for attr in project agentName workflowType; do
  temporal operator search-attribute create --namespace "$NS" --name "$attr" --type Keyword || true
done
echo "registered: project, agentName, workflowType (Keyword) in $NS"
