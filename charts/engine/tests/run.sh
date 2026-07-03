#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
diff <(helm template engine . --namespace dev-agents) tests/render.golden.yaml
