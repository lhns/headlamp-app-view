# 0003 — Discover all resource kinds (incl. CRDs) at runtime

Status: Accepted

## Context

The per-app view must include **custom resources**, not just built-in kinds — an
app's footprint often includes CRs (certificates, backups, scaled objects, etc.).
A hard-coded list of kinds would miss CRDs and any new kinds added later.

Kubernetes has **no single "all objects with label X" endpoint**: you cannot ask
the API server for every object cluster-wide matching a label. Objects must be
listed **per (group, version, resource)**.

## Decision

**Enumerate the cluster's API resources at runtime** via the discovery endpoints —
`/api/v1` (core) and `/apis` → each group/version → its `resources[]` — keep the
entries that are **listable** (`list` in `verbs`) and are **not subresources**
(name without a `/`), then query each kind, filtered by the app label. This covers
**built-ins and CRDs** with no per-kind code and no hard-coded list.

## Consequences

- **Pro**: Future-proof and complete — new CRDs appear in the view automatically,
  with zero code changes.
- **Pro**: A genuinely exhaustive per-app picture, which is the whole point.
- **Con**: Many API calls (one list per kind). Mitigated by caching discovery,
  capping concurrency, and the two-tier split (see
  [ADR 0004](0004-two-tier-querying.md)).
- **Con**: The view can only show what the **viewing identity's RBAC** permits
  listing; kinds the user can't `list` are silently absent.
