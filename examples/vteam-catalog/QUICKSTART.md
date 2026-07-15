# vTeam Catalog Manual Reload Quickstart

Use this to stand up the vTeam Catalog lab environment from the manifests by hand.
The lab is **self-contained**: it runs against a clean/empty cluster and creates
everything it needs (project, namespace, gateway, agents, providers) itself via
`acpctl apply`. `make kind-up` only brings up the cluster and platform — it does
**not** pre-create the `vteam-product-swarm` tenant.

## 0. Start From The Feature Worktree

```bash
cd "$(git rev-parse --show-toplevel)"
git status --short --branch
```

Expected branch:

```text
acp-mvp-lab
```

## 1. Create The Local Kind Cluster

This lab runs on Docker. If Podman is also installed, `make` selects Podman by
default, so later commands such as `make kind-status` and
`make test-vteam-catalog-lab` look for the cluster under the wrong engine and
report `No ambient Kind cluster found` even though it is running. Export the
engine once so every command in this lab targets Docker:

```bash
export CONTAINER_ENGINE=docker
```

Then create the cluster:

```bash
make kind-up OPENSHELL_USE_GATEWAY=true
```

This provisions the cluster, the platform, and the OpenShell gateway
infrastructure. It does **not** create the `vteam-product-swarm` project or
namespace — you create those in step 4 by applying the catalog.

After it finishes, check the assigned ports:

```bash
make kind-status
```

Look for the `backend` port in the output. The examples below call it
`$API_PORT`.

If `acpctl` is not already on `PATH`, build and install it:

```bash
make build-cli
```

Use this helper in the commands below so either the installed CLI or a local
binary works:

```bash
if command -v acpctl >/dev/null 2>&1; then
  ACPCTL=acpctl
elif [ -x components/ambient-cli/acpctl ]; then
  ACPCTL=components/ambient-cli/acpctl
else
  echo "acpctl not found; run: make build-cli" >&2
  return 1 2>/dev/null || exit 1
fi
```

## 2. Start Port-Forwarding

Run this in a second terminal and leave it running:

```bash
cd "$(git rev-parse --show-toplevel)"
make kind-port-forward
```

If you prefer to background it:

```bash
cd "$(git rev-parse --show-toplevel)"
make kind-port-forward > /tmp/acp-kind-port-forward.log 2>&1 &
```

## 3. Log `acpctl` Into The Local API

In the first terminal, log in with the Makefile helper:

```bash
make kind-acpctl-login
```

If you need to do the same steps manually, derive the backend port from
`make kind-status` and read the local test token:

```bash
API_PORT=$(make -s kind-status | awk '
  /Forward:/ {
    for (i = 1; i <= NF; i++) {
      if ($i == "(backend)") {
        print $(i - 1)
      }
    }
  }
')
TOKEN=$(kubectl get secret test-user-token -n ambient-code \
  -o jsonpath='{.data.token}' | base64 -d)

"$ACPCTL" login \
  --url "http://localhost:${API_PORT}" \
  --token "$TOKEN"
```

Quick check that login works. The vTeam project does **not** exist yet — you
create it in the next step:

```bash
"$ACPCTL" get projects
```

## 4. Apply The vTeam Catalog Manifests

This is the core lab step. Applying the catalog creates the `vteam-product-swarm`
**project** record; the control plane then provisions the backing Kubernetes
namespace and the OpenShell gateway from that record — no `kubectl create
namespace` needed.

```bash
export AMBIENT_PROJECT=vteam-product-swarm
"$ACPCTL" apply \
  -k examples/vteam-catalog/product-swarm \
  --project vteam-product-swarm
```

Verify the ACP records (available immediately after apply):

```bash
"$ACPCTL" get project vteam-product-swarm
"$ACPCTL" agent list --project vteam-product-swarm
"$ACPCTL" provider list --project vteam-product-swarm
```

Verify the Kubernetes-side objects. The namespace and gateway are created by the
control plane reconciler, so they appear a few seconds after the apply — wait for
them rather than expecting them immediately:

```bash
kubectl wait --for=jsonpath='{.status.phase}'=Active \
  namespace/vteam-product-swarm --timeout=60s
kubectl get all,configmap,secret,pvc,serviceaccount,role,rolebinding \
  -n vteam-product-swarm
# The gateway StatefulSet is deployed on the next reconcile pass:
kubectl rollout status statefulset/openshell-gateway \
  -n vteam-product-swarm --timeout=120s
```

## 5. Optional Runtime Secrets

Applying the catalog does not require provider secrets. But starting real
sessions does: at gateway setup the control plane reads each provider's backing
Kubernetes Secret directly from the project namespace, so those Secrets must
exist there. The catalog's providers declare these secret names:

- `vertex-sa-key`
- `github-creds`
- `jira`

Do **not** rely on `make kind-setup-vertex` — that target is scoped to the demo
fleet tenants in `OPENSHELL_TENANTS`, not the catalog project.

Vertex and GitHub each use a secret with a single `token` key, created directly
in the `vteam-product-swarm` namespace (created in step 4):

```bash
# Vertex — token is the full contents of a GCP service-account JSON key
kubectl create secret generic vertex-sa-key \
  --namespace vteam-product-swarm \
  --from-literal=token="$(cat /path/to/gcp-sa-key.json)"

# GitHub — token is a Personal Access Token
kubectl create secret generic github-creds \
  --namespace vteam-product-swarm \
  --from-literal=token="$GITHUB_PAT"
```

Jira (used only by Parker) needs more than a token — the `jira` provider passes
its Secret keys straight through as environment variables, so the Secret must
carry the base URL, account, and API token that the Atlassian MCP expects
(`JIRA_URL`, `JIRA_USERNAME`, `JIRA_API_TOKEN`), matching the tenant example in
[examples/README.md](../README.md):

```bash
kubectl create secret generic jira \
  --namespace vteam-product-swarm \
  --from-literal=JIRA_URL=https://your-org.atlassian.net \
  --from-literal=JIRA_USERNAME="you@example.com" \
  --from-literal=JIRA_API_TOKEN="$(cat ~/jira-token.txt)"
```

Only set up the providers whose agents you actually run. See the
[Credentials concept guide](https://openshift-online.github.io/agent-control-plane/concepts/credentials/)
for how provider secrets, credentials, and runtime wiring fit together. Without
the backing secret/credential for a provider an agent declares, its sessions fail
to start with `reading secret <provider>-creds ... not found`.

## 6. Troubleshooting

Common causes when ACP commands do not show the vTeam records:

- `make kind-port-forward` is not running.
- `acpctl` is logged into the wrong backend port.
- The lab worktree cluster is not running.
- The vTeam manifests have not been applied yet (step 4).

Useful reset commands:

```bash
make kind-status
"$ACPCTL" login --url "http://localhost:${API_PORT}" --token "$TOKEN"
"$ACPCTL" apply -k examples/vteam-catalog/product-swarm --project vteam-product-swarm
```

If `acpctl` is still trying an old URL, re-run the login command with the
current backend port from `make kind-status`.

## 7. Optional: Start A Work Packet Session

Starting real sessions needs the provider secrets from step 5 and the OpenShell
gateway. Both come from the catalog apply (step 4) plus your credentials — the
gateway StatefulSet is deployed by the control plane once the namespace exists.

Once those runtime prerequisites are available, start Stella with the demo work
packet:

```bash
export AMBIENT_PROJECT=vteam-product-swarm
"$ACPCTL" agent start stella \
  --project vteam-product-swarm \
  --prompt "Add dark mode to the calculator"
```

Then inspect sessions:

```bash
export AMBIENT_PROJECT=vteam-product-swarm
"$ACPCTL" agent sessions stella --project vteam-product-swarm
```

## 8. Optional: Automated Lab Check

With the cluster running and `CONTAINER_ENGINE` exported (step 1), you can
validate the whole copy/paste flow end to end:

```bash
make test-vteam-catalog-lab
```
