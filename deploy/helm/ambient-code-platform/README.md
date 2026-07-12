# ambient-code-platform (thin Helm wrapper)

A **thin wrapper** chart for the Ambient Code Platform (ACP). It does not
re-author ACP's manifests as Helm templates. Instead it templatizes only the
cluster-specific values and emits a small kustomize **"light shim"** — a
`kustomization.yaml` plus a few patches — that extends the in-repo ACP
**production** overlay (`components/manifests/overlays/production`), which stays
the source of truth.

ACP images already exist on `quay.io/ambient_code/*`; this chart never builds or
ships images. It only pins image **tags**.

## What it templatizes

| Value | Purpose |
|-------|---------|
| `baseDomain` | Derives default SSO / MLflow URLs |
| `namespace` | Target namespace (default `ambient-code`) |
| `productionOverlayPath` | Path to the production overlay the shim extends |
| `image.registry`, `image.tags.*` | ACP image registry + pinned tags |
| `sso.jwksUrl` | Keycloak/RH-SSO JWKS certs endpoint (`--jwk-cert-url`) |
| `sso.aclEmailRegex` | Email-claim ACL regex |
| `modelAccess.provider` + `modelAccess.vertex.*` | Anthropic key vs Vertex (via `operator-config`) |
| `memoryHub.mcpUrl` | Per-user memory-hub MCP URL (`MEMORY_HUB_MCP_URL`) |
| `mlflow.tracking.{enabled,uri,auth,experiment,workspace}` | MLflow tracking env |

## Rendered artifacts

- `kustomization.yaml` — `resources: [<productionOverlayPath>, operator-config.yaml]`, image pins, and patch wiring.
- `operator-config.yaml` — model-access ConfigMap.
- `ambient-api-server-acl-patch.yaml` — SSO ACL ConfigMap patch.
- `control-plane-env-patch.yaml` — control-plane Deployment env (model access + memory-hub + MLflow).
- The `--jwk-cert-url` override is an inline JSON 6902 patch in `kustomization.yaml`.

Secrets `ambient-anthropic` and `github-app-secret` are managed **out-of-band**.

## Verify

```bash
helm lint deploy/helm/ambient-code-platform
helm template acp deploy/helm/ambient-code-platform --set baseDomain=apps.example.com
```

## Deploy

The rendered kustomization references the production overlay by
`productionOverlayPath` (default `../production`), which assumes the shim is
rendered as a peer of the production overlay (same layout as the `evalstack`
overlay). Recommended flow:

```bash
helm template acp deploy/helm/ambient-code-platform \
  --set baseDomain=apps.<your-cluster> \
  --output-dir /tmp/acp-shim

mkdir -p components/manifests/overlays/acp-shim
cp /tmp/acp-shim/ambient-code-platform/templates/*.yaml \
   components/manifests/overlays/acp-shim/

oc apply -k components/manifests/overlays/acp-shim
```

If you render the shim elsewhere, override the overlay path with an absolute
path:

```bash
helm template acp deploy/helm/ambient-code-platform \
  --set baseDomain=apps.<your-cluster> \
  --set productionOverlayPath=$PWD/components/manifests/overlays/production \
  --output-dir /tmp/acp-shim
```

Alternatively, use a Helm kustomize post-renderer
(`helm template ... --post-renderer kustomize`) that runs `kustomize build` over
the emitted kustomization.

## Relationship to the `evalstack` overlay

`components/manifests/overlays/evalstack/` is the hand-written, static equivalent
of what this chart emits. Use the overlay directly for a fixed config; use this
chart when you need to parameterize the values above per cluster.
