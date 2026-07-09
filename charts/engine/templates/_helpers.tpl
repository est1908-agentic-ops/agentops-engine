{{/*
Shared PROJECT_REGISTRY_JSON computation — both the worker Deployment and the
gateway Deployment render one GITHUB_TOKEN__<PROJECT> secretKeyRef per
project (the gateway needs a real per-project token to fetch agentops.json
via the GitHub API before starting a devCycle) plus this same
PROJECT_REGISTRY_JSON list of project/repo/tokenEnvVar entries. A project
with trackerType: linear additionally gets linearTeamKey/linearTokenEnvVar/
linearTriggerLabelId fields, matching packages/contracts's discriminated
union (see docs/superpowers/specs/2026-07-09-linear-trigger-design.md).
*/}}
{{- define "engine.projectRegistryJson" -}}
{{- $registry := list -}}
{{- range $project, $cfg := .Values.projects }}
{{- $trackerType := $cfg.trackerType | default "github" }}
{{- if eq $trackerType "linear" }}
{{- $registry = append $registry (dict
    "project" $project
    "repo" $cfg.repo
    "trackerType" "linear"
    "tokenEnvVar" (printf "GITHUB_TOKEN__%s" (upper (replace "-" "_" $project)))
    "linearTeamKey" $cfg.linearTeamKey
    "linearTokenEnvVar" (printf "LINEAR_TOKEN__%s" (upper (replace "-" "_" $project)))
    "linearTriggerLabelId" $cfg.linearTriggerLabelId
  ) }}
{{- else }}
{{- $registry = append $registry (dict "project" $project "repo" $cfg.repo "trackerType" "github" "tokenEnvVar" (printf "GITHUB_TOKEN__%s" (upper (replace "-" "_" $project)))) }}
{{- end }}
{{- end }}
{{- $registry | toJson }}
{{- end -}}
