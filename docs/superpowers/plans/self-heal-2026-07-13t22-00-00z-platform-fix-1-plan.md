# Plan — self-heal-2026-07-13t22-00-00z-platform-fix-1

Implements design C (validate-then-install with a bundle-parse assertion) from
`docs/superpowers/specs/self-heal-2026-07-13t22-00-00z-platform-fix-1-design.md`.

Bug: `images/agent-runner/Dockerfile` copies the intentional placeholder
`step-ca-root.crt` (a `BEGIN/END CERTIFICATE` envelope around plain English) into
`/usr/local/share/ca-certificates/` and runs `update-ca-certificates`, which
appends the file verbatim. The non-base64 body corrupts
`/etc/ssl/certs/ca-certificates.crt`, so strict PEM consumers (curl, and any
OpenSSL/GnuTLS client) reject the whole bundle with `error setting certificate
file` — every outbound HTTPS request in the shipped image fails, silently.

The whole change is confined to `images/agent-runner/`. No TypeScript, contracts,
workflows, policies, or Helm values are touched, so `pnpm lint/typecheck/test/e2e`
are unaffected; the real gate is the `build-agent-runner-image` CI job
(`.github/workflows/ci.yaml:106`), which runs `docker build` on this Dockerfile.

## Steps

### Step 1 — Reproduce the breakage (baseline, de-risking)
No file change. Build the current image and confirm the concrete symptom, so the
fix is measured against a known-bad baseline.

- `docker build -t agent-runner:broken images/agent-runner`
- `docker run --rm agent-runner:broken curl -sSI https://registry.npmjs.org`
- **Verify:** the `curl` fails with `error setting certificate file` (or the build
  log shows `update-ca-certificates` adding the placeholder). This confirms the bug
  is real and reproducible before touching anything. If the environment has no
  Docker/network access, record that and fall back to inspecting the build log /
  bundle bytes; the CI `build-agent-runner-image` job is the authoritative gate.

### Step 2 — Ensure `openssl` is available in the build (`images/agent-runner/Dockerfile`)
Add `openssl` to the existing single `apt-get install --no-install-recommends`
line (line 12), keeping the alphabetical-ish grouping and the trailing
`rm -rf /var/lib/apt/lists/*` in the same `RUN`. This guarantees the validation and
bundle-parse commands in Step 3 exist regardless of whether the base pulls openssl
in transitively (the design flags this as uncertain; adding it explicitly removes
the risk and adds no new layer).

- **Verify:** `docker build` reaches the later stages without "openssl: not found";
  or, quick check, `docker run --rm agent-runner:<tag> openssl version` prints a
  version.

### Step 3 — Replace the blind COPY+update with a guarded RUN (`images/agent-runner/Dockerfile`)
Replace lines 31–32:

```
COPY step-ca-root.crt /usr/local/share/ca-certificates/step-ca-root.crt
RUN update-ca-certificates
```

with:
1. A `COPY step-ca-root.crt /tmp/step-ca-root.crt` into a staging path (build-context
   file must be present to validate; staging keeps invalid bytes out of the trust
   dir).
2. A single guarded `RUN` (`set -e`) that:
   - Runs `openssl x509 -in /tmp/step-ca-root.crt -noout` (a real PEM parse).
   - **If it parses:** move the file to
     `/usr/local/share/ca-certificates/step-ca-root.crt`, run
     `update-ca-certificates`, then assert the whole produced bundle parses via
     `openssl crl2pkcs7 -nocrl -certfile /etc/ssl/certs/ca-certificates.crt -out /dev/null`.
     Any failure ends the `RUN` non-zero → build fails loudly (the CI gate).
   - **If it does not parse (placeholder today):** `echo` a clear warning
     (`skipping non-PEM placeholder step-ca-root.crt; system CA bundle unchanged`)
     and continue with exit 0, leaving the stock bundle untouched.
   - Always `rm -f /tmp/step-ca-root.crt` at the end so no invalid bytes linger in
     the image layer.

   Guard against `set -e` aborting on the expected validation failure: run the
   `openssl x509` check as the condition of an `if`/`else` (so a non-zero parse is
   handled, not fatal), while genuine install/assert failures inside the `then`
   branch still abort.

- **Verify (positive/today):** `docker build -t agent-runner:fixed images/agent-runner`
  succeeds, build log shows the "skipping non-PEM placeholder" warning, and
  `docker run --rm agent-runner:fixed curl -sSI https://registry.npmjs.org` returns
  HTTP headers (no `error setting certificate file`). Also confirm the placeholder
  did **not** land in the trust store:
  `docker run --rm agent-runner:fixed sh -c 'ls /usr/local/share/ca-certificates/'`
  shows no `step-ca-root.crt`.
- **Verify (negative gate):** temporarily replace the build-context file with a
  string that `openssl x509` accepts but that corrupts the bundle (or a truncated
  real cert), build, and confirm the build fails at the
  `crl2pkcs7` assertion with a non-zero exit. Revert the temp file afterward. This
  proves the loud-failure path works and is not dead code.
- **Verify (future-cert path, best-effort):** temporarily drop a real valid PEM
  (e.g. a copy of an existing public root) in place, build, and confirm it is
  installed (`ls` shows it) and the bundle still parses. Revert. Confirms the
  in-place-replacement contract needs no further Dockerfile edit.

### Step 4 — Correct the placeholder's now-inaccurate comment (`images/agent-runner/step-ca-root.crt`)
Keep the file (CI's COPY source must exist; the file is a useful slot marker).
Rewrite the comment body so it states the true behavior: the build validates this
file with `openssl x509` and **skips it because it is not a real certificate**, so
the system CA bundle is left unchanged until a real step-ca root replaces this file
in place — at which point it is validated and trusted automatically with no
Dockerfile change. Keep the `BEGIN/END CERTIFICATE` envelope so the shape/path is
unchanged.

- **Verify:** `git diff` shows only comment text changed; the Step 3 build still
  emits the "skipping" warning (the file is still correctly classified invalid).

### Step 5 — Repo-wide sanity checks
- **Verify:** `git status`/`git diff --stat` shows only the two files under
  `images/agent-runner/` changed (plus this plan doc). Optionally run
  `pnpm lint && pnpm typecheck` to confirm no TS surface was disturbed (expected
  clean; no `.ts` changed). Do not need `pnpm test`/`e2e` — no code path changed —
  but they remain green by construction.

## Sequencing notes

- **Step 1 (reproduce) first, deliberately.** It costs one build and pins the
  baseline symptom, so Step 3's "curl now works" verification is meaningful rather
  than assumed. If Docker is unavailable it degrades to a log/bundle inspection and
  does not block the edit.
- **Step 2 (openssl) before Step 3.** Step 3's guard *is* openssl; installing it
  first means Step 3's build can't fail for a missing-tool reason, isolating any
  failure to the guard logic itself. Could be merged into one edit of the Dockerfile,
  but splitting keeps the "make the tool available" concern separate from the
  "change the trust logic" concern for a cleaner diff and easier bisection.
- **Step 4 (comment) after Step 3, not before.** The comment must describe the
  behavior Step 3 actually implements; writing it first risks documenting an
  intention that the code ends up not matching.
- **Step 5 last** — it's a whole-diff audit that only makes sense once the edits
  exist.

## Assumptions

- **`openssl` may not be guaranteed on `node:22-slim`.** Rather than probe and
  branch (the design left this open), I add `openssl` to the existing `apt-get`
  line unconditionally in Step 2. Cost is one already-present-or-tiny package in a
  layer that already installs `ca-certificates`/`curl`; benefit is the guard is
  never skipped for a missing binary. Resolution: always install it.
- **The real step-ca root will replace the file in place** at the same path/name
  (not via a build arg or mount). The guard keys off "valid PEM present at
  `images/agent-runner/step-ca-root.crt`", so in-place replacement needs no further
  Dockerfile edit. Recorded for the M2 sub-project 2 handoff.
- **step-ca trust is genuinely unused at runtime today**, so skipping the
  placeholder changes nothing except removing the bug (public CAs already trusted by
  the base). Per the design's assumption; no repo component talks TLS to a
  step-ca-only endpoint.
- **The negative-gate and future-cert verifications use throwaway local edits**
  that are reverted; they are test scaffolding, never committed. Only the two
  `images/agent-runner/` files (and this plan) change in the PR.
- **No separate CI step is added.** The bundle-parse assertion lives inside the
  Dockerfile `RUN`, so a broken bundle fails `docker build`, which fails the
  existing `build-agent-runner-image` job. Adding a second CI-only check would
  duplicate the gate; keeping it in the image build also protects local/manual
  builds.
