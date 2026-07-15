---
title: vTeam Lab
description: Apply the bundled multi-agent catalog examples to an ACP project
---

The vTeam lab shows how to model a coordinated group of agents with current
ACP resources. Each lab team uses a `Project` as the workspace, `Agent`
records as team members, shared `Provider` records for runtime integrations,
and a project-scoped `Gateway` for OpenShell sandbox execution.

If you use hosted ACP, your platform administrators provide Vertex AI access.
You only need to provide personal or team integration credentials, such as
GitHub and Jira, for examples that use those providers.

## Catalog options

ACP ships two catalog examples:

| Team | Project | Use it for |
| --- | --- | --- |
| Product swarm | `vteam-product-swarm` | Cross-functional product delivery work with product, engineering, design, research, and writing roles. |
| Codebase maintainers | `codebase-maintainers` | Internal codebase upkeep across implementation, runtime readiness, CI, security, docs, and release gates. |

The manifests live in
[examples/vteam-catalog](https://github.com/openshift-online/agent-control-plane/tree/main/examples/vteam-catalog).

The lab is self-contained and runs against a clean cluster: applying a catalog
creates the `Project` record, and the control plane provisions the backing
namespace and gateway from it (see [Gateway and namespace
behavior](#gateway-and-namespace-behavior)). On a local Kind cluster, `make
kind-up` only provisions the demo fleet (`tenant-a`, `tenant-b`); it does not
pre-create the vTeam tenants — the apply step below does.

## Apply a catalog team

Log in to ACP with `acpctl`, then apply one catalog directory to its matching
project.

```bash
acpctl apply -k examples/vteam-catalog/product-swarm \
  --project vteam-product-swarm
```

```bash
acpctl apply -k examples/vteam-catalog/codebase-maintainers \
  --project codebase-maintainers
```

The apply step creates or updates ACP records. Provider credentials become
runtime requirements when a session starts.

See
[examples/README.md](https://github.com/openshift-online/agent-control-plane/blob/main/examples/README.md)
for the full examples inventory, including starter tenant examples and the
shared gateway field reference.

## Gateway and namespace behavior

Each catalog team declares an OpenShell `Gateway` named `openshell-gateway`.
ACP deploys that gateway into the project namespace, not into a namespace named
after the gateway.

For example, the `product-swarm` catalog uses:

```yaml
kind: Project
name: vteam-product-swarm
```

```yaml
kind: Gateway
name: openshell-gateway
server_dns_names:
  - openshell-gateway.vteam-product-swarm.svc.cluster.local
```

When the `Project` record is applied, the control plane creates the namespace
`vteam-product-swarm` (no `kubectl create namespace` needed) and then, on a
subsequent reconcile pass, deploys the gateway Kubernetes resources there. Both
are eventually consistent — they appear a few seconds after the apply.

## Verify

After applying a catalog team, check the ACP records:

```bash
# Product swarm
acpctl get project vteam-product-swarm
acpctl agent list --project vteam-product-swarm
acpctl provider list --project vteam-product-swarm

# Codebase maintainers
acpctl get project codebase-maintainers
acpctl agent list --project codebase-maintainers
acpctl provider list --project codebase-maintainers
```

On a local Kind cluster, also check the project namespaces. These are created by
the control plane reconciler after the apply, so wait for them rather than
expecting them immediately:

```bash
kubectl wait --for=jsonpath='{.status.phase}'=Active \
  namespace/vteam-product-swarm --timeout=60s
kubectl rollout status statefulset/openshell-gateway \
  -n vteam-product-swarm --timeout=120s

kubectl wait --for=jsonpath='{.status.phase}'=Active \
  namespace/codebase-maintainers --timeout=60s
kubectl rollout status statefulset/openshell-gateway \
  -n codebase-maintainers --timeout=120s
```

For a hand-run local reload flow, use the
[vTeam Catalog quickstart](https://github.com/openshift-online/agent-control-plane/blob/main/examples/vteam-catalog/QUICKSTART.md).
