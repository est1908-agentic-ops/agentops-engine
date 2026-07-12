#!/usr/bin/env bash
# Updates agentops-platform engine deploy pins after a merge to agentops-engine main.
# Requires: ENGINE_SHA, PLATFORM_DIR (checkout path, authenticated via a
# fine-grained PAT passed to actions/checkout's token input).
set -euo pipefail

: "${ENGINE_SHA:?ENGINE_SHA is required}"
: "${PLATFORM_DIR:?PLATFORM_DIR is required}"

cd "${PLATFORM_DIR}"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git fetch origin main
git checkout main
git pull --ff-only origin main

python3 - "${ENGINE_SHA}" <<'PY'
import pathlib
import re
import sys

sha = sys.argv[1]
root = pathlib.Path("clusters/ops/engine")

values = root / "values.yaml"
text = values.read_text()
text = re.sub(r"^(  workerTag:\s*).*$", rf'\g<1>"{sha}"', text, flags=re.M)
text = re.sub(r"^(  agentRunnerTag:\s*).*$", rf'\g<1>"{sha}"', text, flags=re.M)
text = re.sub(r"^(  gatewayTag:\s*).*$", rf'\g<1>"{sha}"', text, flags=re.M)
text = re.sub(r"^(  controlTag:\s*).*$", rf'\g<1>"{sha}"', text, flags=re.M)
values.write_text(text)

app = root / "application.yaml"
app_text = app.read_text()
app_text, n = re.subn(
    r"(repoURL: oci://gitactions\.est1908\.top/agentic-ops/engine\n\s*chart: engine\n\s*targetRevision:\s*).*$",
    rf'\g<1>"0.0.0-{sha}"',
    app_text,
    count=1,
    flags=re.M,
)
if n != 1:
    raise SystemExit("expected exactly one engine chart targetRevision to update")
app.write_text(app_text)

# project-worker ApplicationSet chart pin (docs/superpowers/specs/2026-07-12-
# project-worker-onboarding-design.md SP-a). Guarded: inert until the platform
# ApplicationSet exists, so this is safe to land in the engine repo first.
appset = pathlib.Path("clusters/ops/project-workers/applicationset.yaml")
if appset.exists():
    appset_text = appset.read_text()
    appset_text, m = re.subn(
        r"(repoURL: oci://gitactions\.est1908\.top/agentic-ops/project-worker\n\s*chart: project-worker\n\s*targetRevision:\s*).*$",
        rf'\g<1>"0.0.0-{sha}"',
        appset_text,
        count=1,
        flags=re.M,
    )
    if m != 1:
        raise SystemExit("expected exactly one project-worker chart targetRevision to update")
    appset.write_text(appset_text)
PY

if git diff --quiet; then
  echo "platform pins already at ${ENGINE_SHA}; nothing to commit"
  exit 0
fi

short_sha="${ENGINE_SHA:0:7}"
git add clusters/ops/engine/values.yaml clusters/ops/engine/application.yaml clusters/ops/project-workers/applicationset.yaml
git commit -m "chore(engine): bump worker images to ${short_sha}"
git push origin main
