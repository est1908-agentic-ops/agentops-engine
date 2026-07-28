#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
diff <(helm template engine . --namespace dev-agents | sed '${/^$/d;}') tests/render.golden.yaml

# Public-registry case (S1): with no pull secret, every Deployment must omit
# imagePullSecrets. Rendering `- name: ""` produces invalid Deployments, which
# is what the unguarded templates did — worker, gateway and control alike.
if helm template engine . --namespace dev-agents --set imagePullSecretName= \
  | grep -q "imagePullSecrets"; then
  echo "FAIL: imagePullSecrets rendered despite an empty imagePullSecretName" >&2
  exit 1
fi
echo "OK: imagePullSecrets omitted when imagePullSecretName is empty"
