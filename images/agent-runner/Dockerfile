# syntax=docker/dockerfile:1
#
# Shared image for every agent-CLI backend (claude, pi, ...). Combined per
# 2026-07-06 decision (see ARCHITECTURE.md §5.4): both CLIs are thin
# `npm install -g` wrappers on the same node:22-slim base with no conflicting
# system deps, so one pinned image is simpler to build/push/roll than one
# per backend. Revisit the split if a future backend (cursor, codex) needs a
# meaningfully different or heavier toolchain.
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git openssl \
    && rm -rf /var/lib/apt/lists/*

# kubectl for the platform role's read-only cluster-state investigation --
# harmless for every other role's
# Jobs, which run under the dev-agents namespace's `default` ServiceAccount
# with no RBAC bindings: the binary is present but useless without a bound
# Role/ClusterRole, so this doesn't change what a devCycle Job can reach.
RUN curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/v1.31.1/bin/linux/amd64/kubectl" \
    && chmod +x /usr/local/bin/kubectl

RUN npm install --global @anthropic-ai/claude-code@2.1.200

# Package confirmed via https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md
# and https://www.npmjs.com/package/@earendil-works/pi-coding-agent (2026-07-06) — installs
# the `pi` binary. --ignore-scripts per that README: pi needs no install-time lifecycle
# scripts, and skipping them is the recommended posture for Docker/CI installs.
RUN npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.80.2

COPY step-ca-root.crt /tmp/step-ca-root.crt
RUN set -e; \
    if openssl x509 -in /tmp/step-ca-root.crt -noout 2>/dev/null; then \
      mv /tmp/step-ca-root.crt /usr/local/share/ca-certificates/step-ca-root.crt; \
      update-ca-certificates; \
      openssl crl2pkcs7 -nocrl -certfile /etc/ssl/certs/ca-certificates.crt -out /dev/null; \
    else \
      echo "skipping non-PEM placeholder step-ca-root.crt; system CA bundle unchanged"; \
    fi; \
    rm -f /tmp/step-ca-root.crt

# Claude Code reads ~/.claude/skills/; pi reads ~/.agents/skills/ (and
# ~/.pi/agent/skills/, .agents/skills/, .pi/skills/) — the two CLIs share no
# discovery path, so every skill needed by both backends is copied to both
# locations so both supported CLIs discover the same stage guidance.
COPY --chown=1000:1000 skills/platform-ops      /home/node/.claude/skills/platform-ops
COPY --chown=1000:1000 skills/platform-ops      /home/node/.agents/skills/platform-ops
COPY --chown=1000:1000 skills/design-brainstorm /home/node/.claude/skills/design-brainstorm
COPY --chown=1000:1000 skills/design-brainstorm /home/node/.agents/skills/design-brainstorm
COPY --chown=1000:1000 skills/plan-writer       /home/node/.claude/skills/plan-writer
COPY --chown=1000:1000 skills/plan-writer       /home/node/.agents/skills/plan-writer

# Numeric, not the name "node": kubelet can't verify a pod's runAsNonRoot
# against a named image user without a matching explicit runAsUser in the
# pod spec (see K8sJobRunner's buildAgentJob, which already sets one).
USER 1000
WORKDIR /workspace
