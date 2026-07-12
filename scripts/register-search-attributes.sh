#!/usr/bin/env bash
# Register the custom Temporal search attributes the reconciler/Schedule/
# continuous-start stamp (SP2 design §7). Idempotent: "already exists" is fine.
# Usage: TEMPORAL_ADDRESS=... TEMPORAL_NAMESPACE=... ./scripts/register-search-attributes.sh
set -euo pipefail
NS="${TEMPORAL_NAMESPACE:?set TEMPORAL_NAMESPACE}"
for attr in project agentName workflowType; do
  temporal operator search-attribute create --namespace "$NS" --name "$attr" --type Keyword || true
done
echo "registered: project, agentName, workflowType (Keyword) in $NS"
