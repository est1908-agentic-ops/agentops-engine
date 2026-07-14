#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
diff <(helm template acme . --namespace dev-agents \
  --set project=acme \
  --set image=gitactions.est1908.top/acme/agentops-worker:testsha \
  --set temporal.address=temporal-frontend.platform.svc.cluster.local:7233 \
  --set temporal.namespace=dev-agents \
  --set otel.endpoint=http://alloy.platform.svc.cluster.local:4317 \
  --set 'externalSecretRefs={rollbar-token}') tests/render.golden.yaml