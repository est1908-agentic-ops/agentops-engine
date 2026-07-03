# syntax=docker/dockerfile:1
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global @anthropic-ai/claude-code@2.1.200

COPY step-ca-root.crt /usr/local/share/ca-certificates/step-ca-root.crt
RUN update-ca-certificates

USER node
WORKDIR /workspace
