#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
diff <(helm template broccoli . --namespace dev-agents \
  --set project=broccoli \
  --set image=gitactions.est1908.top/broccoli/agentops-worker:testsha \
  --set temporal.address=temporal-frontend.platform.svc.cluster.local:7233 \
  --set temporal.namespace=dev-agents \
  --set otel.endpoint=http://alloy.platform.svc.cluster.local:4317 \
  --set 'externalSecretRefs={rollbar-token}') tests/render.golden.yaml