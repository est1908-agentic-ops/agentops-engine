#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# The example image is deliberately a placeholder registry, not a real one: this
# chart is published publicly, and its tests shouldn't advertise a private
# registry as the pattern. It's a project-BUILT image ref, so the value is
# arbitrary as far as the template is concerned.
render() {
  helm template acme . --namespace dev-agents \
    --set project=acme \
    --set image=registry.example.com/acme/agentops-worker:testsha \
    --set temporal.address=temporal-frontend.platform.svc.cluster.local:7233 \
    --set temporal.namespace=dev-agents \
    --set otel.endpoint=http://alloy.platform.svc.cluster.local:4317 \
    --set 'externalSecretRefs={rollbar-token}' \
    "$@"
}

diff <(render) tests/render.golden.yaml

# Public-registry case (S1): with no pull secret, the Deployment must omit
# imagePullSecrets entirely. Rendering `- name: ""` produces an invalid
# Deployment, which is what an unguarded template did.
if render --set imagePullSecretName= | grep -q "imagePullSecrets"; then
  echo "FAIL: imagePullSecrets rendered despite an empty imagePullSecretName" >&2
  exit 1
fi
echo "OK: imagePullSecrets omitted when imagePullSecretName is empty"
