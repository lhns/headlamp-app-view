# 0002 — Group resources by the `app.kubernetes.io/instance` label

Status: Accepted

## Context

Kubernetes has **no native "application" object**. To group resources into "apps"
we need a key. The candidates:

- **Namespace** — too coarse and not app-identity: several apps can share a
  namespace, an app can span namespaces, and "namespace" answers a different
  question than "which app is this."
- **The SIG `Application` CRD** (`app.k8s.io`) — an actual app-grouping CRD, but the
  project is **dormant/abandoned**; adopting it adds a controller for little gain.
- **Flux `Kustomization`/`HelmRelease` ownership** — works only in this GitOps
  setup, is tool-coupled, and not every resource traces cleanly back to one Flux
  object (Helm-managed resources, adopted resources).
- **The `app.kubernetes.io/*` recommended labels** — the standard, tool-agnostic
  convention. **`app.kubernetes.io/instance`** identifies a *deployed instance* of
  an app, and most Helm charts set it automatically.

## Decision

Group by **`app.kubernetes.io/instance`**. Read the sibling recommended labels for
extra columns/metadata: `app.kubernetes.io/version` (running version),
`app.kubernetes.io/part-of` (larger app grouping), `app.kubernetes.io/managed-by`.

## Consequences

- **Pro**: **API-selectable** — labels (unlike annotations) can be queried with a
  selector, so grouping is cheap and server-side-filterable.
- **Pro**: Tool-agnostic and usually **already present** (charts set it); works the
  same whether an app is deployed by Helm, Flux, or plain manifests.
- **Con**: Only surfaces resources that **carry the label** — unlabeled objects are
  invisible to the view.
- **Con**: Requires the label convention to be applied consistently across apps
  (plain-manifest apps need it added).
