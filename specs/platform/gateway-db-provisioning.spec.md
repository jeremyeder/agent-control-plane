# Gateway Database Provisioning Specification

**Date:** 2026-07-17
**Status:** Design
**Extends:** `gateway-provisioning.spec.md` — gateway lifecycle and reconciliation
**Related:** `data-model.spec.md` — Gateway kind definition; `control-plane.spec.md` — CP reconciliation patterns
**Upstream:** [OpenShell Helm Chart `server.externalDbSecret`](https://github.com/NVIDIA/OpenShell/tree/main/deploy/helm/openshell) — external PostgreSQL integration

---

## Purpose

The control plane SHALL optionally provision a PostgreSQL database alongside each OpenShell gateway deployment. Today, gateways use an embedded SQLite database stored on a PVC attached to a StatefulSet. This limits gateways to a single replica and ties data durability to pod-local storage.

When a Gateway resource declares `database.type: postgres`, the GatewayReconciler SHALL provision a dedicated PostgreSQL Deployment, PVC, Service, and credentials Secret in the same namespace. The gateway workload switches from StatefulSet to Deployment and reads its database connection string from the provisioned Secret via the `OPENSHELL_DB_URL` environment variable, following the upstream OpenShell `server.externalDbSecret` pattern.

This enables:
- **PostgreSQL-backed gateways** — production-grade storage with standard PostgreSQL tooling
- **Deployment workload** — no StatefulSet PVC required for the gateway itself; database has its own PVC
- **Extensible database backends** — the `database.type` field supports `sqlite` (default), `postgres` (this spec), and future backends (e.g., `rds`)
- **Lifecycle coupling** — the database is created and destroyed with the gateway; no orphaned resources

---

## Requirements

### Requirement: Gateway Database Configuration Field

The Gateway resource SHALL support an optional `database` field that controls the database backend. When absent or null, the gateway uses the default SQLite behavior (backward compatible).

#### Scenario: Gateway with PostgreSQL database

- GIVEN a Gateway resource:
  ```yaml
  kind: Gateway
  name: openshell-gateway
  project: tenant-a
  database:
    type: postgres
    storageSize: 10Gi
  image: ghcr.io/nvidia/openshell:v0.0.70
  serverDnsNames:
    - openshell-gateway.tenant-a.svc.cluster.local
  ```
- WHEN the GatewayReconciler processes the Gateway
- THEN it SHALL provision a PostgreSQL Deployment, PVC, Service, and Secret in the `tenant-a` namespace
- AND it SHALL deploy the gateway as a Deployment (not StatefulSet)
- AND the gateway container SHALL receive `OPENSHELL_DB_URL` from the provisioned Secret

#### Scenario: Gateway with default SQLite database

- GIVEN a Gateway resource with no `database` field (or `database.type: sqlite`)
- WHEN the GatewayReconciler processes the Gateway
- THEN it SHALL deploy the gateway as a StatefulSet with embedded SQLite (existing behavior)
- AND no PostgreSQL resources SHALL be provisioned

#### Scenario: Gateway with unsupported database type

- GIVEN a Gateway resource with `database.type: rds`
- WHEN the GatewayReconciler validates the configuration
- THEN it SHALL log a validation warning: unsupported database type
- AND it SHALL NOT provision any database resources
- AND it SHALL NOT deploy the gateway (configuration is invalid until corrected)

---

### Requirement: Database Field Schema

The `database` field SHALL be a JSONB object on the Gateway resource with the following sub-fields:

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `type` | string | Yes (when `database` is set) | `sqlite` | Database backend: `sqlite`, `postgres`. Reserved for future: `rds`. |
| `storageSize` | string | No | `5Gi` | PVC storage request for the PostgreSQL data volume. Only applicable when `type: postgres`. Ignored for `type: sqlite`. |

#### Scenario: Database field defaults

- GIVEN a Gateway resource with `database: { type: postgres }` and no `storageSize`
- WHEN the GatewayReconciler provisions the database PVC
- THEN the PVC SHALL request `5Gi` of storage

#### Scenario: Database field absent

- GIVEN a Gateway resource with no `database` field
- WHEN the GatewayReconciler processes the Gateway
- THEN it SHALL treat the gateway as `database.type: sqlite`
- AND behavior SHALL be identical to the pre-existing gateway provisioning

---

### Requirement: PostgreSQL Resource Provisioning

When `database.type` is `postgres`, the GatewayReconciler SHALL provision the following Kubernetes resources in the gateway's project namespace. All resources SHALL use update-or-create semantics (never create-and-ignore-AlreadyExists).

#### Scenario: Provision PostgreSQL resources

- GIVEN a Gateway with `database.type: postgres` in project `tenant-a`
- AND the namespace `tenant-a` exists
- WHEN the GatewayReconciler reconciles the Gateway
- THEN it SHALL create or update these resources:

**Secret** (`openshell-gateway-db`):
- Key `db.user`: `openshell`
- Key `db.password`: cryptographically random 32-character password
- Key `db.name`: `openshell`
- Key `uri`: `postgresql://openshell:<password>@openshell-gateway-db:5432/openshell?sslmode=disable`
- The password SHALL be generated using `crypto/rand` (32 bytes, base64url-encoded, truncated to 32 characters)

**PVC** (`openshell-gateway-db-data`):
- Access mode: `ReadWriteOnce`
- Storage request: value of `database.storageSize` (default `5Gi`)

**Deployment** (`openshell-gateway-db`):
- Replicas: 1
- Image: `postgres:16`
- Environment variables from Secret `openshell-gateway-db`:
  - `POSTGRES_USER` from key `db.user`
  - `POSTGRES_PASSWORD` from key `db.password`
  - `POSTGRES_DB` from key `db.name`
- Environment variable: `PGDATA=/var/lib/postgresql/data/pgdata`
- Volume mount: PVC `openshell-gateway-db-data` at `/var/lib/postgresql/data`
- Container port: 5432
- Readiness probe: `pg_isready -U "$POSTGRES_USER"` (initialDelaySeconds: 10, periodSeconds: 10)
- Liveness probe: `pg_isready -U "$POSTGRES_USER"` (initialDelaySeconds: 30, periodSeconds: 30)
- Resource requests: `cpu: 100m`, `memory: 256Mi`
- Resource limits: `cpu: 500m`, `memory: 512Mi`
- SecurityContext: `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, capabilities `drop: [ALL]`
- Strategy: `Recreate` (single-replica database; rolling update is not safe)

**Service** (`openshell-gateway-db`):
- Type: `ClusterIP`
- Port: 5432 → 5432

- AND all resources SHALL carry labels:
  - `app.kubernetes.io/name: openshell`
  - `app.kubernetes.io/component: database`
  - `app.kubernetes.io/managed-by: agent-control-plane`
  - `ambient-code.io/managed: true`

#### Scenario: PostgreSQL resources already exist (idempotency)

- GIVEN `tenant-a` already has PostgreSQL resources provisioned for the gateway
- WHEN the GatewayReconciler reconciles again
- THEN it SHALL apply the latest configuration using update-or-create semantics
- AND it SHALL NOT create duplicate resources
- AND the existing Secret password SHALL be preserved (not regenerated)

---

### Requirement: Database Credential Security

The database credentials Secret SHALL be generated securely and the password SHALL never be exposed in logs, error messages, or API responses.

#### Scenario: Password generation

- GIVEN a new Gateway with `database.type: postgres`
- AND no `openshell-gateway-db` Secret exists in the namespace
- WHEN the GatewayReconciler provisions the database
- THEN it SHALL generate a 32-character password using `crypto/rand`
- AND it SHALL construct the `uri` value as `postgresql://openshell:<password>@openshell-gateway-db:5432/openshell?sslmode=disable`
- AND the password SHALL NOT appear in any log messages (use `len(password)` for logging)

#### Scenario: Password preservation on reconcile

- GIVEN an `openshell-gateway-db` Secret already exists with a password
- WHEN the GatewayReconciler reconciles the Gateway
- THEN it SHALL read the existing password from the Secret
- AND it SHALL NOT overwrite the password
- AND the `uri` value SHALL be recomputed using the existing password (in case other URI components changed)

#### Scenario: Secret deleted externally

- GIVEN the `openshell-gateway-db` Secret is deleted by an external actor
- WHEN the GatewayReconciler reconciles the Gateway
- THEN it SHALL generate a new password and recreate the Secret
- AND the gateway SHALL pick up the new credentials on its next restart

---

### Requirement: Gateway Workload Switching

When `database.type` is `postgres`, the gateway workload SHALL be deployed as a Deployment instead of a StatefulSet. This follows the upstream OpenShell pattern where `server.externalDbSecret` requires `workload.kind=deployment`.

#### Scenario: Deploy gateway as Deployment with PostgreSQL

- GIVEN a Gateway with `database.type: postgres`
- WHEN the GatewayReconciler deploys the gateway workload
- THEN it SHALL create a Deployment named `openshell-gateway` (not a StatefulSet)
- AND the Deployment SHALL NOT include a VolumeClaimTemplate for `openshell-data`
- AND the gateway container SHALL NOT include `--db-url sqlite:...` in its args
- AND the gateway container SHALL include an environment variable:
  ```yaml
  - name: OPENSHELL_DB_URL
    valueFrom:
      secretKeyRef:
        name: openshell-gateway-db
        key: uri
  ```
- AND the Deployment SHALL retain all other gateway container configuration (TLS mounts, config volume, probes, ports, SecurityContext)

#### Scenario: Deploy gateway as StatefulSet with SQLite

- GIVEN a Gateway with `database.type: sqlite` (or no `database` field)
- WHEN the GatewayReconciler deploys the gateway workload
- THEN it SHALL create a StatefulSet named `openshell-gateway` (existing behavior)
- AND the StatefulSet SHALL include a VolumeClaimTemplate for `openshell-data`
- AND the gateway container SHALL include `--db-url sqlite:/var/openshell/openshell.db` in its args

---

### Requirement: Resource Provisioning Order

The GatewayReconciler SHALL provision database resources before the gateway workload to ensure the database is available when the gateway starts.

#### Scenario: Provisioning order for postgres mode

- GIVEN a Gateway with `database.type: postgres`
- WHEN the GatewayReconciler reconciles the Gateway
- THEN it SHALL provision resources in this order:
  1. Database Secret (`openshell-gateway-db`)
  2. Database PVC (`openshell-gateway-db-data`)
  3. Database Deployment (`openshell-gateway-db`)
  4. Database Service (`openshell-gateway-db`)
  5. Gateway RBAC (ServiceAccount, Role, RoleBinding — existing)
  6. Gateway ConfigMap (existing)
  7. Gateway certgen Job (existing)
  8. Gateway Service (existing)
  9. Gateway Deployment (`openshell-gateway` — new workload kind)
  10. Gateway NetworkPolicy (existing)

#### Scenario: Database not yet ready

- GIVEN the PostgreSQL Deployment is provisioned but not yet ready
- WHEN the gateway Deployment starts
- THEN the gateway container SHALL fail its readiness probe (database unreachable)
- AND Kubernetes SHALL retry the gateway pod until the database becomes available
- AND the GatewayReconciler SHALL NOT block — it relies on Kubernetes restart/readiness behavior

---

### Requirement: Database Type Transition

When a Gateway's `database.type` changes between `sqlite` and `postgres`, the GatewayReconciler SHALL cleanly transition between workload types and manage database resource lifecycle.

#### Scenario: Transition from sqlite to postgres

- GIVEN a Gateway currently deployed as a StatefulSet with `database.type: sqlite`
- WHEN the Gateway is updated to `database.type: postgres`
- THEN the GatewayReconciler SHALL:
  1. Provision PostgreSQL resources (Secret, PVC, Deployment, Service)
  2. Delete the existing StatefulSet (`openshell-gateway`)
  3. Deploy a new Deployment (`openshell-gateway`) with `OPENSHELL_DB_URL`
- AND the SQLite VolumeClaimTemplate PVC SHALL be cleaned up

#### Scenario: Transition from postgres to sqlite

- GIVEN a Gateway currently deployed as a Deployment with `database.type: postgres`
- WHEN the Gateway is updated to `database.type: sqlite`
- THEN the GatewayReconciler SHALL:
  1. Delete the existing Deployment (`openshell-gateway`)
  2. Deploy a new StatefulSet (`openshell-gateway`) with SQLite
  3. Delete PostgreSQL resources (Deployment, Service, PVC, Secret named `openshell-gateway-db*`)
- AND data in the PostgreSQL database SHALL be permanently lost
- AND this is a known destructive operation

---

### Requirement: Gateway Deletion with Database

When a Gateway with `database.type: postgres` is deleted, all associated database resources SHALL also be deleted.

#### Scenario: Delete gateway with postgres database

- GIVEN a Gateway with `database.type: postgres` exists in project `tenant-a`
- AND PostgreSQL resources (Secret, PVC, Deployment, Service) exist in the namespace
- WHEN the Gateway is deleted
- THEN the GatewayReconciler SHALL delete all gateway K8s resources (existing behavior)
- AND it SHALL delete the database Deployment `openshell-gateway-db`
- AND it SHALL delete the database Service `openshell-gateway-db`
- AND it SHALL delete the database PVC `openshell-gateway-db-data`
- AND it SHALL delete the database Secret `openshell-gateway-db`
- AND data in the PostgreSQL database SHALL be permanently lost

#### Scenario: Delete gateway with sqlite database

- GIVEN a Gateway with `database.type: sqlite` (or no `database` field)
- WHEN the Gateway is deleted
- THEN the GatewayReconciler SHALL delete all gateway K8s resources (existing behavior)
- AND no database resources exist to clean up

---

### Requirement: New Manifest Templates

The control plane container SHALL include manifest templates for the PostgreSQL database resources and the gateway Deployment workload variant.

#### Scenario: Database manifest template

- GIVEN the ACP container includes gateway manifests at `/manifests/gateway/`
- THEN a `db-deployment.yaml` manifest SHALL exist containing:
  - PostgreSQL Deployment (`openshell-gateway-db`)
  - PVC (`openshell-gateway-db-data`) with `STORAGE_SIZE_PLACEHOLDER`
  - Service (`openshell-gateway-db`)
- AND the manifest SHALL use `NAMESPACE_PLACEHOLDER` for namespace substitution
- AND the manifest SHALL follow the same structure as `components/manifests/base/platform/ambient-api-server-db.yml`

#### Scenario: Gateway Deployment manifest template

- GIVEN the ACP container includes gateway manifests at `/manifests/gateway/`
- THEN a `deployment.yaml` manifest SHALL exist containing:
  - A Deployment (`openshell-gateway`) with the same pod spec as `statefulset.yaml`
  - No VolumeClaimTemplates
  - An `OPENSHELL_DB_URL` env var sourced from `secretKeyRef` on Secret `openshell-gateway-db` key `uri`
  - No `--db-url` CLI argument
- AND the existing `statefulset.yaml` SHALL be preserved for `database.type: sqlite` mode

---

## Configuration

### Gateway Resource Schema (Updated)

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | Yes | — | Resource name (typically `openshell-gateway`) |
| `project` | Yes | — | Project name (determines target namespace) |
| `image` | No | `OPENSHELL_GATEWAY_IMAGE` env var | Gateway container image reference |
| `serverDnsNames` | Yes | — | DNS names for TLS certificate generation |
| `config` | No | — | OpenShell gateway TOML configuration |
| `database` | No | — | Database backend configuration (see below) |
| `database.type` | Yes (when `database` set) | `sqlite` | `sqlite`, `postgres`, or future `rds` |
| `database.storageSize` | No | `5Gi` | PVC size for PostgreSQL data. Only for `type: postgres` |

### Example: Gateway with PostgreSQL

```yaml
kind: Gateway
name: openshell-gateway
project: tenant-a
image: ghcr.io/nvidia/openshell:v0.0.70
serverDnsNames:
  - openshell-gateway.tenant-a.svc.cluster.local
database:
  type: postgres
  storageSize: 10Gi
config: |
  [openshell.gateway]
  bind_address = "0.0.0.0:8080"
```

### Example: Gateway with SQLite (default, backward compatible)

```yaml
kind: Gateway
name: openshell-gateway
project: tenant-a
image: ghcr.io/nvidia/openshell:v0.0.70
serverDnsNames:
  - openshell-gateway.tenant-a.svc.cluster.local
```

---

## Migration

### Relationship to Existing Specs

This specification extends `gateway-provisioning.spec.md`. It does not replace any existing requirements. All existing gateway provisioning behavior remains unchanged when `database.type` is `sqlite` or absent.

### Data Model Changes Required

The Gateway kind in `data-model.spec.md` SHALL gain a `database` JSONB field:

```
Gateway {
    ...existing fields...
    jsonb  database "nullable — database backend config: {type, storageSize}"
}
```

A database migration SHALL add the `database` column to the `gateways` table:

```sql
ALTER TABLE gateways ADD COLUMN database JSONB;
```

### New Components

| Component | Purpose |
|---|---|
| `manifests/gateway/db-deployment.yaml` | PostgreSQL Deployment + PVC + Service template |
| `manifests/gateway/deployment.yaml` | Gateway Deployment template (postgres mode) |
| DB provisioning logic in GatewayReconciler | Password generation, Secret creation, DB resource reconciliation |

### Backward Compatibility

When `database` is null (the default), all behavior is identical to the current system. Existing Gateway resources without a `database` field continue to work as StatefulSets with SQLite. No migration of existing gateways is required.

---

## RBAC Requirements

No additional RBAC grants are required. The control plane ServiceAccount already has permissions to create Deployments, Services, Secrets, and PersistentVolumeClaims in project namespaces (granted by `control-plane-clusterrole.yaml`).

---

## References

- [OpenShell Helm Chart — `server.externalDbSecret`](https://github.com/NVIDIA/OpenShell/tree/main/deploy/helm/openshell)
- [OpenShell Kubernetes Setup — External DB](https://docs.nvidia.com/openshell/latest/kubernetes/setup)
- [gateway-provisioning.spec.md](./gateway-provisioning.spec.md) — Gateway lifecycle and reconciliation
- [data-model.spec.md](./data-model.spec.md) — Gateway kind definition
- [ambient-api-server-db.yml](../../components/manifests/base/platform/ambient-api-server-db.yml) — Existing PostgreSQL deployment pattern
