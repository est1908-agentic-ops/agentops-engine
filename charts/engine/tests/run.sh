#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
diff <(helm template engine . --namespace dev-agents | sed '${/^$/d;}') tests/render.golden.yaml
