# 0004 — Two-tier querying: light app list, full per-app detail

Status: Accepted

## Context

Discovering and listing **every** kind across the whole cluster
([ADR 0003](0003-runtime-all-kinds-discovery.md)) is expensive. Doing that on the
landing **app-list** page — before the user has even picked an app — would make it
slow and hammer the API server.

But the two pages need different depth: the **list** page only needs *summary*
columns per app (resource/pod counts, a health rollup, the ingress URL, version),
while the **detail** page needs the *exhaustive* per-kind breakdown of one app.

## Decision

Split the work:

- **App list** — query a **light, fixed set** of kinds (workloads + pods + PVCs +
  ingresses) plus label values, enough to build the summary rows.
- **App detail** — run the **full all-kinds sweep**, but scoped to the **one
  selected app** (label selector `app.kubernetes.io/instance=<name>`), on demand.

## Consequences

- **Pro**: The landing page stays fast; the expensive exhaustive sweep only runs
  for a single app when the user opens it.
- **Pro**: Bounds cluster-wide load — the heavy query is never cluster-wide *and*
  all-kinds at the same time.
- **Con**: The list's summary columns are **approximate** (derived from the light
  set) and may not count exotic CRs that only the detail sweep surfaces.
- **Con**: Two query code paths to maintain.
