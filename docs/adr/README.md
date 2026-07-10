# Architecture Decision Records

Each ADR captures a single decision: the context, what was decided, and the
consequences. ADRs are immutable once accepted — if a decision is reversed, a new
ADR supersedes the old one.

## Index

1. [0001 — A Headlamp plugin, not a standalone app-view tool](0001-headlamp-plugin-not-standalone-tool.md)
2. [0002 — Group resources by the `app.kubernetes.io/instance` label](0002-group-by-instance-label.md)
3. [0003 — Discover all resource kinds (incl. CRDs) at runtime](0003-runtime-all-kinds-discovery.md)
4. [0004 — Two-tier querying: light app list, full per-app detail](0004-two-tier-querying.md)
5. [0005 — Distribution: own repo → image → initContainer into Headlamp](0005-distribution-image-initcontainer.md)
