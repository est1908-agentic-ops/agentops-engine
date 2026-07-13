#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Test 1: Default (no ingress, no basic auth middleware)
diff <(helm template engine . --namespace dev-agents) tests/render.golden.yaml

# Test 2: With control ingress and basic auth enabled, verify Middleware and
# annotation are rendered correctly
helm template engine . --namespace dev-agents \
  --set control.ingress.enabled=true \
  --set control.ingress.host=control.example.com \
  --set control.ingress.basicAuth.enabled=true \
  --set control.ingress.basicAuth.usersSecretName=control-basic-auth \
  --set temporalUiBaseUrl=http://temporal.example.com:8233 | \
  grep -q "kind: Middleware" && echo "✓ Middleware rendered" || echo "✗ Middleware NOT rendered"

helm template engine . --namespace dev-agents \
  --set control.ingress.enabled=true \
  --set control.ingress.host=control.example.com \
  --set control.ingress.basicAuth.enabled=true \
  --set control.ingress.basicAuth.usersSecretName=control-basic-auth \
  --set temporalUiBaseUrl=http://temporal.example.com:8233 | \
  grep -q "engine-control-basic-auth@kubernetescrd" && echo "✓ Middleware annotation correct" || echo "✗ Middleware annotation NOT found"
