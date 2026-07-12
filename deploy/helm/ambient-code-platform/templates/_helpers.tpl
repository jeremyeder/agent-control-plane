{{/*
Resolve the SSO JWKS URL: explicit value wins, else derive from baseDomain.
*/}}
{{- define "acp.jwksUrl" -}}
{{- if .Values.sso.jwksUrl -}}
{{ .Values.sso.jwksUrl }}
{{- else -}}
https://keycloak.{{ .Values.baseDomain }}/realms/ambient-code/protocol/openid-connect/certs
{{- end -}}
{{- end -}}

{{/*
Resolve the MLflow tracking URI: explicit value wins, else derive from baseDomain.
*/}}
{{- define "acp.mlflowUri" -}}
{{- if .Values.mlflow.tracking.uri -}}
{{ .Values.mlflow.tracking.uri }}
{{- else -}}
https://mlflow.{{ .Values.baseDomain }}
{{- end -}}
{{- end -}}
