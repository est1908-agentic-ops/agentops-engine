{{/*
Shared PROJECT_REGISTRY_JSON computation — both the worker Deployment and the
gateway Deployment render one GITHUB_TOKEN__<PRODUCT> secretKeyRef per
project (the gateway needs a real per-project token to fetch agentops.json
via the GitHub API before starting a devCycle) plus this same
PROJECT_REGISTRY_JSON list of product/repo/tokenEnvVar entries.
*/}}
{{- define "engine.projectRegistryJson" -}}
{{- $registry := list -}}
{{- range $product, $cfg := .Values.projects }}
{{- $registry = append $registry (dict "product" $product "repo" $cfg.repo "trackerType" "github" "tokenEnvVar" (printf "GITHUB_TOKEN__%s" (upper (replace "-" "_" $product)))) }}
{{- end }}
{{- $registry | toJson }}
{{- end -}}
