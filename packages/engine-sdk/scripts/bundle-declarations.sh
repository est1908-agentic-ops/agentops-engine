#!/usr/bin/env bash
# Emit the SDK declarations, then package the private workspace declaration
# dependencies beneath dist/. Consumers must never have to install @agentops/*.
set -euo pipefail

SDK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$SDK_DIR/../.." && pwd)"
cd "$REPO_DIR"

pnpm --filter @agentops/contracts build
pnpm --filter @agentops/policies build
"$SDK_DIR/node_modules/.bin/tsc" -p "$SDK_DIR/tsconfig.json" --composite false --incremental false --emitDeclarationOnly --outDir "$SDK_DIR/dist"

mkdir -p "$SDK_DIR/dist/_internal/contracts" "$SDK_DIR/dist/_internal/policies"
find "$REPO_DIR/packages/contracts/dist" -maxdepth 1 -type f -name '*.d.ts' ! -name '*.test.d.ts' -exec cp {} "$SDK_DIR/dist/_internal/contracts/" \;
find "$REPO_DIR/packages/policies/dist" -maxdepth 1 -type f -name '*.d.ts' ! -name '*.test.d.ts' -exec cp {} "$SDK_DIR/dist/_internal/policies/" \;

rewrite_declaration() {
  local declaration="$1"
  local temporary="${declaration}.tmp"
  sed \
    -e "s#'@agentops/contracts'#'../contracts/index'#g" \
    -e 's#"@agentops/contracts"#"../contracts/index"#g' \
    "$declaration" > "$temporary"
  mv "$temporary" "$declaration"
}

while IFS= read -r -d '' declaration; do
  rewrite_declaration "$declaration"
done < <(find "$SDK_DIR/dist/_internal/policies" -type f -name '*.d.ts' -print0)

source="$SDK_DIR/dist/workflow.d.ts"
temporary="${source}.tmp"
sed \
  -e "s#'@agentops/contracts'#'./_internal/contracts/index'#g" \
  -e 's#"@agentops/contracts"#"./_internal/contracts/index"#g' \
  -e "s#'@agentops/policies'#'./_internal/policies/index'#g" \
  -e 's#"@agentops/policies"#"./_internal/policies/index"#g' \
  "$source" > "$temporary"
mv "$temporary" "$source"

cp "$SDK_DIR/dist/workflow.d.ts" "$SDK_DIR/dist/workflow.d.cts"
cp "$SDK_DIR/dist/worker.d.ts" "$SDK_DIR/dist/worker.d.cts"
