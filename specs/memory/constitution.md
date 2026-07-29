<!--
Sync Impact Report - ACP Constitution
Version: 2.0.0-draft
Status: DRAFT (not yet ratified)
Derived from: ambient-code/platform .specify/memory/constitution.md v1.1.0

Why 2.0.0 (MAJOR): this draft redefines Principles I and II to match ACP's
as-built architecture, a backward-incompatible principle redefinition per the
Version Policy below.

Deltas from upstream v1.1.0 (grounded in a codebase audit, 2026-07-29):
  - Principle I RENAMED + REDEFINED: PostgreSQL is the source of truth and the
    control plane reconciles via gRPC watch streams. CRDs (AgenticSession,
    RFEWorkflow) are no longer domain objects; K8s is the execution substrate.
  - Principle II REDEFINED: identity via OIDC/SSO + authorization via Postgres
    RBAC + scoped backend ServiceAccount (user-token K8s passthrough removed).
    OpenShell privileged mode declared a GOVERNED EXCEPTION.
  - Principle V: 200-line hard limit reframed as a review trigger (the hard ban
    was fiction — 49 hand-written Go files + 43 UI files exceed it today).
  - Principle VI: MLflow tracing declared the sanctioned AI-execution
    observability layer; Prometheus /metrics kept as MUST-adopt with a tracked
    gap (currently zero instrumentation).
  - Principle IX (Data Access / MCP / RLHF / RAG) DROPPED from this constitution.
  - Principle VIII (and the former X, now IX) labeled honestly by maturity.
  - NEW section: "Enforcement & Constitutional Alignment" maps every principle
    to a concrete enforcement surface in this repo.

Governance model (updated 2026-07-29):
  - SDD manifest + preflight are being RETIRED. This file is the single ACP
    platform constitution; the runner constitution's Parent link now resolves.
  - AGENTS.md is the authoritative conventions file (CLAUDE.md is a symlink
    alias). See Authority.
  - No line-length / PR-size check: commit scope is a review judgment, not a
    mechanical gate.

Follow-up TODOs (tracked gaps from the audit):
  - Extend token/secret redaction from the Python runner into the Go services.
  - Add a control-plane test job + Go coverage reports to unit-tests.yml.
  - Add Prometheus /metrics to long-running services (api-server, control-plane, gateway).
  - Update AGENTS.md (CLAUDE.md symlink): GetK8sClientsForRequest no longer
    exists; document the OIDC/SSO + Postgres RBAC + backend-SA model instead.
  - Remove sdd-manifest.yaml + sdd-preflight.yml and their references in
    BOOKMARKS.md and runner-constitution.md (SDD retirement).
-->

# ACP Constitution

**Version**: 2.0.0-draft &nbsp;|&nbsp; **Status**: DRAFT &nbsp;|&nbsp; **Derived from**: ambient-code/platform v1.1.0

This is the platform constitution for the Agent Control Plane (ACP): a
Kubernetes-native AI automation platform (Go API server + control plane, NextJS
UI, Python runner) where **PostgreSQL is the source of truth** and the control
plane reconciles desired state into the cluster via gRPC watch streams.

Component constitutions inherit from this document and add local constraints
(see [Runner Constitution](../platform/runner-constitution.md)).

Each principle carries a **maturity label**:
- **ENFORCED** — required today and mechanically checked (see Enforcement).
- **REQUIRED** — required today, enforcement partial or manual.
- **ASPIRATIONAL** — endorsed direction; not yet built or not yet enforced.

---

## Core Principles

### I. Kubernetes-Native Execution, PostgreSQL-Authoritative State — REQUIRED

ACP separates **state** (authoritative in PostgreSQL) from **execution**
(Kubernetes). Features MUST honor this split:

- **PostgreSQL is the source of truth** for all domain objects (sessions,
  projects, project settings, credentials, roles). Persistent domain state is a
  database model with SQL migrations in the API server — never a CRD, never etcd.
- **The control plane reconciles via gRPC watch streams** against the API
  server (`WatchSessions`, `WatchProjects`, `WatchProjectSettings`), projecting
  database state into the cluster. It is a reconciler, not a CRD operator.
- **Kubernetes is the execution and isolation substrate.** Per-project
  Namespaces, per-session ServiceAccount/Role/RoleBinding, Jobs, Pods, PVCs,
  Secrets, Services/Routes, and Sandbox CRs (via the OpenShell gateway) MUST be
  used for running and isolating workloads.
- **Legacy CRDs are not domain objects.** `AgenticSession` and `RFEWorkflow`
  MUST NOT be treated as a source of truth. Existing `vteam.ambient-code` RBAC
  references are retained for backward compatibility only and MUST NOT be
  extended as an authoritative API.

**Rationale**: etcd/CRDs do not scale to unbounded, frequently-mutated objects
and lack relational query power. A relational source of truth with a gRPC
reconciliation loop gives ACP transactional integrity while preserving
Kubernetes' operational and isolation guarantees for execution.

### II. Security & Multi-Tenancy First — REQUIRED

Security and isolation MUST be embedded in every component:

- **Identity via OIDC/SSO** (Keycloak in dev), **authorization via
  project-scoped RBAC persisted in PostgreSQL.** Every user-facing operation
  MUST be authorized against the caller's project role.
- **Least-privilege cluster access.** Cluster operations run under a scoped
  backend ServiceAccount. Every session MUST receive an isolated namespace and a
  dedicated ServiceAccount/Role/RoleBinding scoped to its own pods (`get`/`watch`
  only). Cross-project access MUST be impossible by construction.
- **No secrets or tokens in logs, errors, or responses.** Redaction is
  mandatory in ALL components (log with `len(token)`, return generic messages).
  *(Current gap: redaction is implemented in the Python runner and MUST be
  extended to the Go services.)*
- **Restricted SecurityContext on all containers by default**: `runAsNonRoot`,
  drop `ALL` capabilities, `readOnlyRootFilesystem`, `allowPrivilegeEscalation:
  false`.
- **OpenShell privileged mode is a GOVERNED EXCEPTION.** Any relaxation of
  container hardening (e.g. `runAsUser: 0`, added capabilities) MUST be gated
  behind an explicit feature flag, scoped to the OpenShell sandbox path, and
  MUST NOT be the default for standard runner workloads.

**Rationale**: Enterprise multi-tenancy is non-negotiable. A relational RBAC
model with per-session namespace isolation delivers least privilege without
threading user Kubernetes tokens through every layer; privileged execution is
sometimes necessary but must be an auditable, gated exception — never the norm.

### III. Type Safety & Error Handling (NON-NEGOTIABLE) — ENFORCED

No panics in runtime code, no `any` types, explicit error wrapping with context.

- Go runtime code MUST NOT `panic()`; return wrapped `fmt.Errorf("...: %w", err)`.
- Frontend TypeScript MUST NOT use `any`; use precise types, `unknown`, or
  generics.
- Codegen tooling is exempt from the panic rule; runtime code is not.

**Rationale**: Runtime panics crash reconciler loops and kill services.
Explicit error handling ensures debuggability and operational stability.

### IV. Test-Driven Development — REQUIRED

TDD is mandatory for all new functionality, following red-green-refactor:

- **Contract tests** for every API/gRPC endpoint and library interface.
- **Integration tests** for multi-component interactions.
- **Unit tests** for business logic; **permission tests** for RBAC boundaries.
- **E2E tests** for critical user journeys.
- **CI MUST gate merges on all tests**, and MUST include **every** long-running
  component. *(Current gap: the control plane has test files but no CI test job;
  Go backends produce no coverage reports — both MUST be added.)*

**Rationale**: Tests written after implementation miss edge cases and don't
drive design. A component whose tests don't run in CI is untested in practice.

### V. Component Modularity — REQUIRED

Code MUST be organized into clear, single-responsibility modules:

- **Handlers**: HTTP/gRPC/watch logic; delegate business logic to services.
- **Types/models**: data structures and persistence mapping.
- **Services**: reusable business logic, no direct transport handling.
- **No cyclic dependencies**: package imports MUST form a DAG.
- **Frontend colocation**: single-use components beside their pages, reusable
  ones in `/components`.
- **Size as a review trigger, not a hard gate**: source files exceeding **300
  lines** SHOULD be justified or decomposed. Known large files (the reconciler,
  the largest handlers) are tracked technical debt and MUST NOT grow without
  justification. Generated code is exempt.

**Rationale**: Modular architecture enables parallel development and simpler
testing. A hard line-count ban is unenforceable and gets waived into
meaninglessness; a review trigger with tracked debt is honest and actionable.

### VI. Observability & Monitoring — REQUIRED

All components MUST support operational visibility:

- **Structured logging** with context (namespace, resource, operation).
- **Health endpoints** (`/health`/`/healthz`/`/readyz`) for all services.
- **Kubernetes events** for reconciler actions; **status subresource** updates
  for reconciled state.
- **MLflow tracing** is the sanctioned observability layer for AI execution
  (session spans, tool calls, feedback scores) and MUST be maintained.
- **Prometheus `/metrics`** on a dedicated management port is REQUIRED for
  long-running services (API server, control plane, gateway), exposing latency
  percentiles (p50/p95/p99), error rates, and throughput. *(Current gap: no
  Prometheus instrumentation exists yet; this is a MUST-adopt with a tracked
  remediation, not an optional item.)*

**Rationale**: Without observability, MTTR explodes. MLflow answers "what did
the agent do?"; Prometheus answers "is the platform healthy?" — ACP needs both.

### VII. Resource Lifecycle Management — ENFORCED

All child resources MUST have OwnerReferences enabling cascading deletion.

- Session-scoped resources are owned by the session ServiceAccount (the anchor
  object, since no session CRD exists), giving in-namespace cascading delete.
- Creation MUST be idempotent (`ensureX` update-or-create), never
  create-and-ignore-`AlreadyExists`.
- No transient orphans: an OwnerReference MUST be set at creation time, not
  deferred to a later reconcile.

**Rationale**: Resource leaks waste cluster capacity and cause outages. Proper
ownership guarantees automatic cleanup.

### VIII. Context Engineering & Prompt Optimization — ASPIRATIONAL

ACP is a context-engineering hub; AI output quality depends on input quality.
The following are endorsed targets, not yet implemented:

- **Context budgets** and prioritization (system > history > examples).
- **Standardized prompt templates** for common operations (RFE analysis, review).
- **Context compression / session summarization** to preserve history in budget.
- **Agent personas / inheritance** for consistent roles.
- **Incremental context loading** (avoid reloading static content).

**Rationale**: Poor context management causes hallucinations and wasted spend.
Naming this as an unbuilt principle keeps it on the roadmap and prevents ad-hoc
prompt sprawl.

### IX. Commit Discipline & Code Review — REQUIRED

Each commit MUST be atomic, reviewable, and independently testable.

- **Conventional format**: `type(scope): description` (`feat`, `fix`, `refactor`,
  `test`, `docs`, `chore`, `perf`, `ci`).
- **Atomic & self-contained**: each commit passes tests and linters; no WIP
  commits (squash before PR).
- **Reviewability over size limits**: PR scope is kept reasonable by reviewer
  judgment and CODEOWNERS — **not** by a mechanical line-count / PR-size gate.
  No line-length check is imposed.

**Rationale**: Atomic, conventionally-formatted commits keep history bisectable
and reviews focused. Hard line-count gates get waived into meaninglessness and
penalize legitimate large changes; scope is a review judgment, not a number.

---

## Development Standards

Per-language conventions (Go, frontend, Python), build commands, and
naming/legacy-migration rules are authoritative in [`/AGENTS.md`](/AGENTS.md)
(with `CLAUDE.md` as a symlink alias) and [`/BOOKMARKS.md`](/BOOKMARKS.md), and in
the component standards under [`specs/standards/`](../standards/). This
constitution does not duplicate them.

### Production Requirements

- Scan container images for vulnerabilities before deployment.
- Centralized logging + alerting; MLflow tracing retained for AI execution.
- Horizontal Pod Autoscaling; appropriate resource requests/limits.
- Job concurrency and queue management.
- Multi-tenancy with shared infrastructure and per-project isolation.
- **PostgreSQL, not etcd**, for unbounded/frequently-mutated domain objects.

---

## Enforcement & Constitutional Alignment

Alignment is enforced through layered, mostly-automated gates. "Active" = wired
today; "Proposed" = a tracked follow-up to close an audit gap.

| # | Principle | Primary enforcement surface | Status |
|---|-----------|-----------------------------|--------|
| I | K8s-native / DB-authoritative | `operator-review` agent + `specs/standards/control-plane/conventions.spec.md` + code review | **Active** (review-driven) |
| II | Security & Multi-Tenancy | `security-review` agent, `.coderabbit.yaml`, `scripts/hooks/pr-review-gate.sh`, `specs/security/*`; **Proposed**: CI grep-gate for tokens-in-logs + extend Go redaction | Partial |
| III | Type Safety & Error Handling | `golangci-lint` (`scripts/pre-commit/golangci-lint.sh` + `lint.yml`), `go vet`, `tsc --noEmit`/`npm run build` (CI), ESLint `no-explicit-any` | **Active** |
| IV | Test-Driven Development | `unit-tests.yml`, `vteam-catalog-lab-e2e.yml`; **Proposed**: add control-plane job + Go `-coverprofile` upload | Partial |
| V | Component Modularity | Code review + `operator-review` agent (layering + complexity as review judgment) | Review-driven |
| VI | Observability & Monitoring | MLflow e2e (`test_kind_mlflow_e2e.py`); **Proposed**: CI check that services expose `/metrics` + `/healthz` | Partial |
| VII | Resource Lifecycle | `operator-review` agent (checks OwnerReferences + SecurityContext) + reconciler unit tests | **Active** |
| VIII | Context Engineering | None yet (roadmap) | Aspirational |
| IX | Commit Discipline | CODEOWNERS + `.mergify.yml` (required reviews) + CodeRabbit; conventional format by convention — **no line-length / PR-size check** | Review-driven |

**Cross-cutting gates already active:**
- **Pre-commit** (`.pre-commit-config.yaml`): gofmt, go vet, golangci-lint, ruff,
  large-file guard, branch/push protection.
- **PR review gate** (`scripts/hooks/pr-review-gate.sh`): lint/format/secrets +
  CodeRabbit AI review; blocks `gh pr create` on failure.
- **Merge gating**: CODEOWNERS, `.mergify.yml` (required reviews + green CI),
  merge queue via `unit-tests.yml`.
- **Convention health**: `/align` (`convention-eval` agent) scores alignment
  across the codebase.

---

## Governance

### Amendment Process

1. **Proposal**: document the change + rationale (PR editing this file).
2. **Review**: evaluate impact on code, specs, templates, and enforcement.
3. **Approval**: requires project maintainer approval.
4. **Migration**: update dependent specs, component constitutions, and CI.
5. **Versioning**: bump per the policy below; the PR MUST be approved by a
   maintainer via CODEOWNERS on `specs/memory/**`.

### Version Policy

- **MAJOR**: backward-incompatible principle removal or redefinition.
- **MINOR**: new principle/section or materially expanded guidance.
- **PATCH**: clarifications, wording, non-semantic refinements.

### Authority

[`/AGENTS.md`](/AGENTS.md) (with `CLAUDE.md` as a symlink alias) and
[`/BOOKMARKS.md`](/BOOKMARKS.md) remain the authoritative source of shared
engineering conventions. This constitution owns platform governance: the
principles, their maturity, the enforcement mapping, and the amendment process.
**If they conflict on a shared convention, AGENTS.md wins.**

With the SDD manifest/preflight retired, this file is the single ACP platform
constitution; component constitutions (e.g. the runner) inherit from it directly.

### Compliance

- All PRs MUST satisfy the enforcement gates above for the concerns they touch.
- Maturity downgrades (REQUIRED → ASPIRATIONAL) or exceptions (e.g. OpenShell
  hardening waiver) MUST be justified in the PR and, where applicable,
  feature-gated.

---

**Version**: 2.0.0-draft &nbsp;|&nbsp; **Ratified**: (pending) &nbsp;|&nbsp; **Last Amended**: 2026-07-29
