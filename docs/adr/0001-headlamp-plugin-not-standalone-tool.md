# 0001 — A Headlamp plugin, not a standalone app-view tool

Status: Accepted

## Context

The goal is an **application-centric view** — all of an app's Kubernetes resources
in one place, with state — inside the UI already in use (**Headlamp**). Headlamp is
organized by resource *type*, so it lists/filters per kind; it has no built-in
"application" grouping.

Standalone tools do offer app-centric views: Capacitor (a Flux UI), Portainer's
Kubernetes "Applications" view, and the Argo CD UI's resource tree. But each means
**running and adopting another tool/plane** — and Argo CD specifically means a
*second GitOps engine* alongside Flux. Headlamp, by contrast, is explicitly
**extensible via plugins**.

## Decision

Build a **Headlamp plugin** that adds the application view, rather than adopting a
separate tool.

## Consequences

- **Pro**: One UI. The view lives where the operator already works, and reuses
  Headlamp's authentication, RBAC handling, theming, and component library — so it
  looks and behaves natively.
- **Pro**: Fits the existing plugin-delivery mechanism (Headlamp's `pluginsManager`
  / plugins directory); no new deployment plane.
- **Pro**: No second GitOps engine or overlapping management tool.
- **Con**: A plugin is real software to build and maintain (a TypeScript/React
  project with its own toolchain).
- **Con**: Bound to the stability of Headlamp's plugin API and component surface.
