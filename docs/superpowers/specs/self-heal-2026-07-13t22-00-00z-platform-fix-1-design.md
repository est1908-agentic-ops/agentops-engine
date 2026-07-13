# Design — self-heal-2026-07-13t22-00-00z-platform-fix-1

## Goal

`images/agent-runner/Dockerfile` copies `step-ca-root.crt` into
`/usr/local/share/ca-certificates/` and runs `update-ca-certificates`. That
`.crt` is an intentional placeholder: a `BEGIN/END CERTIFICATE` envelope wrapped
around plain-English text (no real cert yet — it's pending M2 sub-project 2 in
the agentops-platform repo). The file comments claim `update-ca-certificates`
"skips invalid entries with a warning" so the build stays clean.

That claim is false. `update-ca-certificates` does **not** parse or validate PEM;
for every `*.crt` under `/usr/local/share/ca-certificates/` it appends the file's
bytes verbatim into the system bundle `/etc/ssl/certs/ca-certificates.crt`. The
placeholder's non-base64 body therefore lands in the bundle, and strict PEM
consumers (curl, and likely any OpenSSL/GnuTLS-backed client) reject the entire
bundle with `error setting certificate file`. The result is a runtime image where
**every** outbound HTTPS request fails — which for agent-runner means the agent
CLIs cannot reach the model provider, registries, forge, or tracker APIs. The
build "succeeds" and CI ships a silently-broken image.

Fix the build so a placeholder (or any malformed cert) can never produce a broken
system CA bundle, while keeping the door open for the real step-ca root to be
dropped in later with no further Dockerfile surgery.

## Approaches considered

### A. Remove the COPY + update-ca-certificates step entirely (until a real cert exists)
Delete the two lines and the placeholder file; re-add them when M2 sub-project 2
issues a real root.
- **Trade-off:** Simplest possible fix and guaranteed correct *today* (node:22-slim
  already trusts public CAs, and step-ca is not yet used by anything). But it loses
  the forward-compatibility intent: when the real cert arrives, someone must
  remember to re-add both the file and the build step, and nothing in the repo
  records that requirement anymore. It also throws away the (reasonable) idea of
  pre-provisioning the trust anchor. Reintroduces exactly this footgun later.

### B. Keep the step, add a post-build assertion that the bundle still parses; fail loudly
Leave COPY + update-ca-certificates as-is, then add a build step (or CI step) that
fully parses `/etc/ssl/certs/ca-certificates.crt` (e.g.
`openssl crl2pkcs7 -nocrl -certfile … -out /dev/null`) and fails the build if it
can't.
- **Trade-off:** Turns the silent breakage into a loud, early failure — good. But
  with the placeholder present, the build now **always fails**, which directly
  contradicts the placeholder's documented purpose ("building with this placeholder
  is expected to succeed") and would red-wall CI on `main` until a real cert lands.
  A guard that blocks all builds is not shippable on its own.

### C. Validate each candidate cert before trusting it, then assert the bundle parses (recommended)
Change the trust-provisioning step so it only feeds *valid* PEM certificates into
the trust store: for each candidate `.crt`, run `openssl x509 -noout` (a real parse)
and install it only if it parses; skip invalid ones with a warning. Run
`update-ca-certificates` only when at least one valid cert was installed. Finally,
assert the resulting bundle parses end-to-end and fail the build if it doesn't.
- **Trade-off:** A few more lines of shell in one `RUN` block. In exchange it makes
  the file comment *true* (invalid entries genuinely skipped), keeps the build green
  with the placeholder present, auto-installs the real cert the moment it replaces
  the placeholder (no future Dockerfile edit needed), and still fails loudly if a
  *malformed-but-present* bundle ever slips through. Belt and suspenders.

## Chosen approach

**C — validate-then-install, with a bundle-parse assertion.**

Why C over A: A is correct today but re-arms the same trap. C preserves the
original design intent (pre-provision the step-ca trust anchor) and, critically,
requires **zero** Dockerfile changes when the real root replaces the placeholder —
the validating guard installs it automatically. That matters because the whole
reason the placeholder exists is to hold the slot for that future cert.

Why C over B: B's guard is right, but applied to an intentionally-invalid
placeholder it converts "silently broken image" into "permanently red build,"
breaking the placeholder's stated contract that builds should pass. C keeps that
contract (placeholder → build succeeds, cert simply not trusted yet) *and* keeps
B's loud-failure safety net for the genuinely-broken case (a present cert that
mangles the bundle). C strictly dominates B by adding the per-cert validation gate
in front of it.

The two options the task itself floated ("skip until a real cert is supplied" and
"verify post-build and fail CI loudly") are both realized by C: the placeholder is
skipped *because it fails validation*, and the post-install bundle assertion is the
loud CI gate.

## Assumptions

- **The step-ca root is genuinely not needed yet.** No component in this repo
  currently talks to a step-ca-issued endpoint over TLS that isn't already covered
  by public CAs (`charts/engine/values.yaml` notes the engine's own ingress uses a
  Let's-Encrypt-based ClusterIssuer). *Assumption:* skipping the placeholder's trust
  today changes nothing at runtime; the only regression risk is the bug we're fixing.
- **`openssl` is available in the build stage.** The base is `node:22-slim` and the
  Dockerfile already `apt-get install`s `ca-certificates`/`curl`; *assumption:*
  `openssl` is present (it is pulled in as a dependency of the TLS stack on Debian
  slim) or will be added to the same `apt-get install` line if not — a one-word
  addition, not a new layer.
- **A real cert will later replace the file in place**, at the same path with the
  same name, rather than arriving via a new build arg or mount. *Assumption:* the
  validating guard keys off "valid PEM present at
  `images/agent-runner/step-ca-root.crt`", so an in-place replacement needs no
  further Dockerfile edit. Recorded so the M2 sub-project 2 handoff knows the
  contract.
- **The placeholder file stays in the repo** (its comment is a useful marker and CI
  needs *something* at the COPY source path). *Assumption:* we keep the file, fix its
  now-inaccurate comment to describe the real behavior (validated-and-skipped), and
  do not delete it.

## Design

Single coherent change, confined to the agent-runner image. Nothing outside
`images/agent-runner/` changes; no packages, contracts, workflows, or Helm values
are touched.

### Files affected

1. **`images/agent-runner/Dockerfile`** — replace the current
   ```
   COPY step-ca-root.crt /usr/local/share/ca-certificates/step-ca-root.crt
   RUN update-ca-certificates
   ```
   with a single guarded `RUN` (plus a `COPY` of the candidate into a staging path,
   e.g. `/tmp/`, so the build-context file is available to validate). The guard:
   - Parses the candidate with `openssl x509 -in <staged>.crt -noout`.
   - **If valid:** move it into `/usr/local/share/ca-certificates/`, run
     `update-ca-certificates`, then assert the produced
     `/etc/ssl/certs/ca-certificates.crt` fully parses (e.g.
     `openssl crl2pkcs7 -nocrl -certfile /etc/ssl/certs/ca-certificates.crt -out /dev/null`).
     Any failure `exit 1`s the build — the loud CI gate.
   - **If invalid (the placeholder case):** emit a clear `echo` warning
     ("skipping non-PEM placeholder step-ca-root.crt; system CA bundle unchanged")
     and continue with exit 0, leaving the stock bundle intact.
   - Clean up the staged file so no invalid bytes linger in the image.
   - Add `openssl` to the existing `apt-get install --no-install-recommends` line
     only if a check shows it isn't already present on the base.

2. **`images/agent-runner/step-ca-root.crt`** — keep the file; rewrite its comment
   to state the accurate behavior: the build validates this file and *skips it
   because it is not a real certificate*, so the system CA bundle is left untouched
   until a real step-ca root replaces this file in place (at which point it is
   validated and trusted automatically).

### Data / control flow

Build-time only; no runtime code path changes. Flow inside the new `RUN`:

```
candidate .crt in build context
        │  COPY to /tmp/step-ca-root.crt
        ▼
openssl x509 -noout  ──valid?──► no ──► warn, leave stock bundle, exit 0  (placeholder today)
        │
       yes
        ▼
install to /usr/local/share/ca-certificates/ + update-ca-certificates
        ▼
openssl parse whole /etc/ssl/certs/ca-certificates.crt ──ok?──► no ──► exit 1  (fail build loudly)
        │
       yes ──► image ships with a valid, extended trust store
```

### Error handling / failure modes

- **Placeholder present (today):** validation fails cleanly → warning, no trust
  change → build green, runtime HTTPS works (the bug is fixed).
- **Real valid cert present (future):** installed and trusted, bundle re-verified →
  build green, step-ca endpoints now trusted.
- **Malformed-but-nonempty cert that somehow passes `x509` but corrupts the bundle:**
  caught by the final bundle-parse assertion → `exit 1`, CI red, nothing ships.
- **Empty / missing file:** `openssl x509` fails → treated as invalid → skipped.

### Testing / verification

- Build the image locally (`docker build images/agent-runner`) and confirm it
  succeeds with the placeholder in place.
- In the built image, run `curl -sSI https://registry.npmjs.org` (or any HTTPS URL)
  and confirm it no longer errors with `error setting certificate file` — the
  concrete regression the task describes.
- Sanity-check the negative gate by temporarily swapping in a deliberately-corrupt
  *valid-looking* cert and confirming the build fails at the bundle-parse assertion.
- No unit/e2e suite covers Dockerfile behavior; this is verified via the image
  build itself. `pnpm lint && pnpm typecheck && pnpm test` remain unaffected (no TS
  changes), and CI's `build-agent-runner-image` job exercises the fixed build.

### Scope statement

This is one coherent change: fix the agent-runner CA-provisioning step so a
placeholder cert cannot break the system trust bundle. It does not bundle unrelated
work.

## Brainstorm Summary
**Approaches considered:** (A) delete the COPY/update-ca-certificates step until a real cert exists; (B) keep the step and add a post-build bundle-parse assertion that fails loudly; (C) validate each candidate cert before trusting it, then assert the bundle parses.
**Chosen approach:** C — validate-then-install with a bundle-parse assertion, in a single guarded `RUN` in the agent-runner Dockerfile.
**Why (decisive reasons):** `update-ca-certificates` doesn't validate PEM, so the placeholder's text corrupts `/etc/ssl/certs/ca-certificates.crt` and breaks all HTTPS. C keeps the build green with the placeholder (honoring its documented contract), auto-installs the real step-ca root when it replaces the file in place (no future Dockerfile edit), and still fails CI loudly if a present cert ever mangles the bundle. A re-arms the same footgun; B alone would permanently red-wall the build against the intentional placeholder.
**Key risks/assumptions:** step-ca trust is genuinely unused today; `openssl` is available in the build stage (add to the existing apt-get line if not); the real cert will later replace the file in place at the same path.
