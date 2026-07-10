# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]
### Added
- Namespaces are now clickable links (to the namespace's details page) in the
  Apps list, the per-app summary, and the per-kind resource tables.

### Fixed
- Skip aggregated/virtual API groups during discovery — their objects (e.g.
  `metrics.k8s.io` `PodMetrics`) mirror a pod's labels and were swept into apps,
  but have no CRD/details view, so clicking one opened a blank panel. Aggregated
  groups are now **detected automatically** from the APIService registry (an
  `APIService` with a `spec.service`), with a static fallback (`metrics.k8s.io`,
  `custom.metrics.k8s.io`, `external.metrics.k8s.io`) for view-only identities.
- Drop rollout-history bookkeeping from apps — superseded ReplicaSets (old
  Deployment revisions scaled to `0/0`) and ControllerRevisions (StatefulSet/
  DaemonSet revision snapshots) — which cluttered the resource list.

## [0.1.0] - 2026-07-10
### Added
- Initial release. A Headlamp plugin that adds an **Apps** view — resources
  grouped into applications by the `app.kubernetes.io/instance` label, so you can
  see everything that makes up an app in one place.
- **Apps tab** — one row per app with summary columns: health, version, pods
  (ready/total), resource count, ingress URL (clickable launcher), namespaces,
  and age.
- **Per-app page** — a summary header (the same facts as the list) followed by
  one section per resource **kind**, each with kind-appropriate columns
  (Pod, Deployment, StatefulSet, DaemonSet, Job, CronJob, Service, Ingress, PVC,
  ConfigMap, Secret, …) and a generic name/namespace/ready/age fallback for
  unknown & custom kinds. Sections are ordered workloads → pods → networking →
  config/storage → policy → RBAC (`PREFERRED_KIND_ORDER`), with a back link to
  the list.
- **Runtime API discovery** — every listable kind (built-ins *and* CRDs) is
  discovered from the API server, so custom resources appear automatically
  without a hard-coded list.
- **Owner-reference enrichment** — resources without the instance label that are
  owned by a labelled one (e.g. a CNPG `Cluster` behind labelled pods) are pulled
  into the app by walking `ownerReferences`.
- **Health rollup** — prefers workload-controller readiness
  (Deployment/StatefulSet/DaemonSet, worst-signal-wins) and falls back to pod
  status only when there is no such controller; completed pods (`Succeeded`)
  don't count as unhealthy.
- One cluster-wide sweep, cached briefly and shared by the list and detail pages
  (so opening an app is instant), with concurrency-capped listing.
- Distribution as a public GHCR container image loaded into Headlamp via an
  initContainer + the separate user-plugins dir, coexisting with the chart's
  `pluginsManager`. See the README and the ADRs under `docs/adr/`.
