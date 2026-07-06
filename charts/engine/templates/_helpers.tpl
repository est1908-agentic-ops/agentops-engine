{{/*
Shared PROJECT_REGISTRY_JSON computation — both the worker Deployment (which
also needs each project's token env var name to build a matching
secretKeyRef) and the gateway Deployment (which only needs to resolve
product/repo from webhook payloads, no tokens) consume this same list.
*/}}
{{- define "engine.projectRegistryJson" -}}
{{- $registry := list -}}
{{- range $product, $cfg := .Values.projects }}
{{- $registry = append $registry (dict "product" $product "repo" $cfg.repo "trackerType" "github" "tokenEnvVar" (printf "GITHUB_TOKEN__%s" (upper (replace "-" "_" $product)))) }}
{{- end }}
{{- $registry | toJson }}
{{- end -}}
