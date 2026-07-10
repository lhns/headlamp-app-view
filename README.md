# headlamp-app-view

A [Headlamp](https://headlamp.dev) plugin that adds an **application view** — see all
the resources that make up an app in one place, without leaving Headlamp.

Kubernetes has no native "application" object, so this plugin groups resources by the
standard **`app.kubernetes.io/instance`** label (which most Helm charts already set):

- **Apps tab** — a list of every app in the cluster, with summary columns: version,
  health, pods, resource count, ingress URL (clickable — a launcher), namespace, age.
- **Per-app page** — a summary header (the same facts) followed by one section per
  resource **kind**, each with kind-appropriate columns (mirroring Headlamp's own
  lists) and a generic fallback for unknown/custom kinds. Covers **every kind
  including CustomResources** — the plugin discovers the cluster's API resources at
  runtime rather than using a fixed list, so CRDs show up automatically.

Resources that lack the instance label but are **owned** by a labelled resource
(e.g. a CNPG `Cluster` behind labelled pods) are pulled in by walking
`ownerReferences`.

Design decisions live in [`docs/adr/`](docs/adr/).

## Labelling your apps

The view is only as good as your labels. Grouping is by
`app.kubernetes.io/instance` — here's how to make an app show up cleanly:

- **Helm charts mostly just work.** Most set `app.kubernetes.io/instance` to the
  release name on everything they template, so a Helm-installed app appears with
  no effort.
- **Use one consistent value for the whole app.** Every resource of an app must
  carry the *same* instance value. If a chart uses something other than the plain
  release name (e.g. the Traefik chart emits `traefik-traefik`), match that exact
  value on any extra resources you add — otherwise they split off as a second
  "app".
- **Label what charts don't.** Raw manifests, operator CRs, and network/policy
  objects (a CNPG `Cluster`, a kube-vnet `VirtualNetwork`, …) usually have no
  instance label. Add `app.kubernetes.io/instance: <app>` to their
  `metadata.labels`.
- **Owned resources come along for free.** A resource that lacks the label but is
  *owned* by a labelled one (via `ownerReferences`) is pulled in automatically —
  so you usually only need to label top-level objects, not operator-created
  children.
- **Want a health status? Give the app a workload.** Health is read from
  Deployment/StatefulSet/DaemonSet readiness (falling back to pod status). An app
  that is only config/CRs shows `Unknown` — that's expected, not a bug.
- **Keep instance values unique per app.** Grouping is cluster-wide by the value,
  so don't reuse one value for unrelated deployments (e.g. the same release name
  in two namespaces would merge into one app).

### Bulk-labelling with Kustomize / Flux

To stamp the label on everything a component deploys without editing each file:

```yaml
# kustomization.yaml — includeSelectors:false = metadata only, never
# selectors/pod-templates (so it can't disrupt a workload).
labels:
  - includeSelectors: false
    pairs:
      app.kubernetes.io/instance: my-app
```

```yaml
# ...or on a Flux Kustomization (applied after the build, so it's authoritative):
spec:
  commonMetadata:
    labels:
      app.kubernetes.io/instance: my-app
```

Both only add top-level metadata labels — neither can relabel a Helm chart's
*rendered* pods, so **match** the chart's own instance value rather than trying to
override it.

## Develop

```sh
npm install
npm start        # dev server; load into a local Headlamp
npm run tsc      # type-check
npm run lint
npm run build    # production build -> dist/main.js
```

Point a local Headlamp at your cluster (via a kubeconfig) to test against real data.

## Install (in-cluster)

The plugin ships as a public container image on GHCR
(`ghcr.io/lhns/headlamp-app-view`) that just carries the built bundle under
`/plugins/headlamp-app-view/`. A Headlamp Deployment loads it with an
**initContainer** that copies it into a plugins directory before Headlamp starts
(see [ADR 0005](docs/adr/0005-distribution-image-initcontainer.md)). The image is
public, so no pull secret is needed.

### With the official Headlamp Helm chart

If you also run the chart's **`pluginsManager`** (it installs ArtifactHub plugins
into `/headlamp/plugins` and *prunes anything not in its config* — including this
plugin), load this one from Headlamp's **separate** `-user-plugins-dir` so the
pluginsManager never touches it. Add to your `values.yaml`:

```yaml
config:
  watchPlugins: true
  extraArgs:
    - "-user-plugins-dir=/headlamp/user-plugins"

initContainers:
  - name: app-view-plugin
    image: ghcr.io/lhns/headlamp-app-view:0.1.0   # pin a tag
    command: ["/bin/sh", "-c", "cp -r /plugins/. /headlamp/user-plugins/"]
    volumeMounts:
      - name: app-view-plugin
        mountPath: /headlamp/user-plugins

# a dedicated volume, shared between the initContainer and the main container
volumes:
  - name: app-view-plugin
    emptyDir: {}
volumeMounts:
  - name: app-view-plugin
    mountPath: /headlamp/user-plugins
```

If you **don't** use the pluginsManager, you can skip `extraArgs` and just copy
into the main plugins dir instead (`-plugins-dir`, default `/headlamp/plugins`) —
point both the `command` target and the `volumeMounts` `mountPath` there.

### RBAC

The plugin lists resources across *all* kinds (including CRDs) for the identity
Headlamp uses, so that identity needs broad cluster read (e.g. the `view`
ClusterRole, or `cluster-admin` for a homelab). It only ever shows what that
identity is allowed to `list`.

## License

[Apache-2.0](LICENSE)
