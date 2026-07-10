# 0005 — Distribution: own repo → image → initContainer into Headlamp

Status: Accepted

## Context

This plugin is **separate software** from the GitOps config repo that deploys the
cluster — it has its own toolchain (Node/TypeScript), tests, versioning, and
releases. Headlamp loads plugins from a **plugins directory** (`-plugins-dir`,
default `/headlamp/plugins` in-cluster). A Helm-deployed Headlamp can be fed a
**custom (non-ArtifactHub) plugin** either by an **initContainer** that copies the
built plugin into a shared volume, or by baking a custom Headlamp image. The
existing `pluginsManager` sidecar already populates that same directory with
ArtifactHub plugins.

## Decision

Ship the plugin from **its own repository** as a **container image**
(`ghcr.io/lhns/headlamp-app-view`), mirroring the `kube-pv-reaper` pattern. The
consuming cluster loads it via an **initContainer** that copies `/plugins/*` into
Headlamp's plugins volume, **coexisting** with `pluginsManager`.

(During development the repo is local and the plugin is tested in a local Headlamp;
CI publishing and the in-cluster initContainer wiring are added when it is ready.)

## Consequences

- **Pro**: Clean separation — the GitOps config repo stays pure config and just
  consumes an image, exactly as it consumes other in-house tools.
- **Pro**: Independent versioning/releases; GitOps-friendly (image tag tracked by
  Renovate downstream).
- **Pro**: Coexists with the ArtifactHub-managed plugins in the same plugins dir.
- **Con**: An initContainer + shared-volume wiring to maintain on the Headlamp
  release.
- **Con**: Until (optionally) published to ArtifactHub, it cannot be loaded through
  `pluginsManager` like the official plugins — it needs its own delivery path.
