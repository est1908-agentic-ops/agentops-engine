{{/*
Shared PROJECT_REGISTRY_JSON computation — both the worker Deployment and the
gateway Deployment render one GITHUB_TOKEN__<PROJECT> secretKeyRef per
project (the gateway needs a real per-project token to fetch agentops.json
via the GitHub API before starting a devCycle) plus this same
PROJECT_REGISTRY_JSON list of project/repo/tokenEnvVar entries.
*/}}
{{- define "engine.projectRegistryJson" -}}
{{- $registry := list -}}
{{- range $project, $cfg := .Values.projects }}
{{- $registry = append $registry (dict "project" $project "repo" $cfg.repo "trackerType" "github" "tokenEnvVar" (printf "GITHUB_TOKEN__%s" (upper (replace "-" "_" $project)))) }}
{{- end }}
{{- $registry | toJson }}
{{- end -}}
