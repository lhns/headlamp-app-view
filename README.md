# headlamp-app-view

A [Headlamp](https://headlamp.dev) plugin that adds an **application view** — see all
the resources that make up an app in one place, without leaving Headlamp.

Kubernetes has no native "application" object, so this plugin groups resources by the
standard **`app.kubernetes.io/instance`** label (which most Helm charts already set):

- **Apps tab** — a list of every app in the cluster, with summary columns: version,
  health, pods, resource count, ingress URL (clickable — a launcher), age.
- **Per-app page** — for the selected app, one section per resource **kind** with a
  list under each heading, covering **every kind including CustomResources**. The
  plugin discovers the cluster's API resources at runtime rather than using a fixed
  list, so CRDs show up automatically.

Design decisions live in [`docs/adr/`](docs/adr/).

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

The plugin ships as a container image; a Headlamp Deployment loads it via an
initContainer that copies it into the plugins directory (`/headlamp/plugins`),
coexisting with any `pluginsManager` plugins (see [ADR 0005](docs/adr/0005-distribution-image-initcontainer.md)).

## License

[Apache-2.0](LICENSE)
