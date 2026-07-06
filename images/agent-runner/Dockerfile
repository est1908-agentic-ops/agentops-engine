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
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global @anthropic-ai/claude-code@2.1.200

# Package confirmed via https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md
# and https://www.npmjs.com/package/@earendil-works/pi-coding-agent (2026-07-06) — installs
# the `pi` binary. --ignore-scripts per that README: pi needs no install-time lifecycle
# scripts, and skipping them is the recommended posture for Docker/CI installs.
RUN npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.80.2

COPY step-ca-root.crt /usr/local/share/ca-certificates/step-ca-root.crt
RUN update-ca-certificates

USER node
WORKDIR /workspace
