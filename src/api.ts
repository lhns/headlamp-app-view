/*
 * Copyright 2026 Pierre Kisters
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runtime discovery of every listable resource kind (built-ins + CRDs) and
 * label-filtered listing, so an "app" can be assembled from all of its resources.
 */
import { request } from '@kinvolk/headlamp-plugin/lib/ApiProxy';
import { OwnershipNode, resolveOwnership } from './ownership';

export const INSTANCE_LABEL = 'app.kubernetes.io/instance';
export const VERSION_LABEL = 'app.kubernetes.io/version';
export const PARTOF_LABEL = 'app.kubernetes.io/part-of';
export const MANAGEDBY_LABEL = 'app.kubernetes.io/managed-by';

/** A listable resource kind discovered from the API server. */
export interface ApiResource {
  group: string; // '' for the core group
  version: string;
  plural: string; // the resource name, e.g. "deployments"
  kind: string;
  namespaced: boolean;
}

/** A Kubernetes object annotated with the kind/group it came from. */
export interface AppResource {
  kind: string;
  apiVersion: string;
  group: string;
  plural?: string;
  metadata: {
    name: string;
    namespace?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    [k: string]: any;
  };
  spec?: any;
  status?: any;
  [k: string]: any;
}

let discoveryCache: { at: number; data: ApiResource[] } | null = null;
const DISCOVERY_TTL_MS = 60_000;

/**
 * Aggregated/virtual API groups to skip. Their objects (e.g. metrics.k8s.io's
 * PodMetrics) mirror a pod's labels, so they'd otherwise be swept into an app —
 * but they aren't backed by a CRD/etcd object, so Headlamp has no details view
 * for them (a click opens a blank panel). They're derived data, not app
 * resources, so we drop them from discovery entirely.
 *
 * Aggregated groups are detected automatically from the APIService registry (see
 * aggregatedGroups); this static list is a fallback for when that registry isn't
 * readable (e.g. a view-only identity).
 */
const EXCLUDED_GROUPS_FALLBACK = new Set([
  'metrics.k8s.io',
  'custom.metrics.k8s.io',
  'external.metrics.k8s.io',
]);

/**
 * API groups served by an aggregated (external) apiserver rather than by
 * kube-apiserver itself — an APIService with a `spec.service` set. These are the
 * metrics-style virtual APIs with no CRD/details view. Empty if the APIService
 * registry can't be read.
 */
async function aggregatedGroups(): Promise<Set<string>> {
  const groups = new Set<string>();
  try {
    const svcs = await request('/apis/apiregistration.k8s.io/v1/apiservices');
    for (const s of svcs?.items ?? []) {
      if (s.spec?.service && s.spec?.group) groups.add(s.spec.group);
    }
  } catch (e) {
    // not readable (e.g. view-only) — caller falls back to the static list
  }
  return groups;
}

/**
 * Enumerate every listable, non-subresource kind the API server exposes — core,
 * every API group's preferred version, and all CRDs. Cached briefly.
 */
export async function discover(): Promise<ApiResource[]> {
  if (discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) {
    return discoveryCache.data;
  }

  const out: ApiResource[] = [];
  const seen = new Set<string>();
  const collect = (group: string, version: string, list: any) => {
    for (const r of list?.resources ?? []) {
      if (typeof r.name !== 'string' || r.name.includes('/')) continue; // skip subresources
      if (!Array.isArray(r.verbs) || !r.verbs.includes('list')) continue;
      const key = `${group}/${version}/${r.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ group, version, plural: r.name, kind: r.kind, namespaced: !!r.namespaced });
    }
  };

  try {
    collect('', 'v1', await request('/api/v1'));
  } catch (e) {
    // core group unreadable — unlikely; carry on
  }

  // Auto-detected aggregated groups, plus the static fallback.
  const excluded = new Set([...EXCLUDED_GROUPS_FALLBACK, ...(await aggregatedGroups())]);

  try {
    const groups = await request('/apis');
    await Promise.all(
      (groups?.groups ?? []).map(async (g: any) => {
        const gv: string | undefined =
          g.preferredVersion?.groupVersion || g.versions?.[0]?.groupVersion;
        if (!gv || !gv.includes('/')) return;
        const [group, version] = gv.split('/');
        if (excluded.has(group)) return;
        try {
          collect(group, version, await request(`/apis/${group}/${version}`));
        } catch (e) {
          // a group we can't read — skip
        }
      })
    );
  } catch (e) {
    // no groups — skip
  }

  discoveryCache = { at: Date.now(), data: out };
  return out;
}

/** Map with a concurrency cap so a full sweep doesn't fire hundreds of requests at once. */
async function pMap<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency = 10): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * List every object across every kind matching a label selector (cluster-wide).
 * `labelSelector` = the bare key `app.kubernetes.io/instance` (exists) to find all
 * labelled objects, or `app.kubernetes.io/instance=<app>` to scope to one app.
 */
export async function listAll(labelSelector: string): Promise<AppResource[]> {
  const kinds = await discover();
  const lists = await pMap(
    kinds,
    async (k): Promise<AppResource[]> => {
      const base = k.group ? `/apis/${k.group}/${k.version}` : `/api/${k.version}`;
      try {
        const resp = await request(
          `${base}/${k.plural}?labelSelector=${encodeURIComponent(labelSelector)}`
        );
        return (resp?.items ?? []).map((it: any) => ({
          ...it,
          kind: it.kind || k.kind,
          apiVersion: it.apiVersion || (k.group ? `${k.group}/${k.version}` : k.version),
          group: k.group,
          plural: k.plural,
        }));
      } catch (e) {
        return []; // 403 / 404 / 405 — not listable for us; skip
      }
    },
    20
  );
  return lists.flat();
}

let instancesCache: { at: number; data: AppResource[] } | null = null;
const INSTANCES_TTL_MS = 30_000;

/**
 * Every object carrying the instance label, cluster-wide, cached briefly.
 * Both the Apps list and the per-app detail page read from this single sweep —
 * so opening an app is instant instead of re-scanning every kind again.
 */
export async function listInstances(force = false): Promise<AppResource[]> {
  if (!force && instancesCache && Date.now() - instancesCache.at < INSTANCES_TTL_MS) {
    return instancesCache.data;
  }
  const data = await listAll(INSTANCE_LABEL);
  instancesCache = { at: Date.now(), data };
  return data;
}

/** Find the discovered kind for an ownerReference (apiVersion + kind). */
async function resolveKind(apiVersion: string, kind: string): Promise<ApiResource | undefined> {
  const kinds = await discover();
  let group = '';
  let version = apiVersion;
  if (apiVersion.includes('/')) [group, version] = apiVersion.split('/');
  return (
    kinds.find(k => k.kind === kind && k.group === group && k.version === version) ||
    kinds.find(k => k.kind === kind && k.group === group) // version-agnostic fallback
  );
}

/** Fetch a single object referenced by an ownerReference; null if gone/unreadable. */
async function fetchOwner(ref: any, childNamespace?: string): Promise<AppResource | null> {
  if (!ref?.kind || !ref?.name) return null;
  const rk = await resolveKind(ref.apiVersion || 'v1', ref.kind);
  if (!rk) return null;
  const base = rk.group ? `/apis/${rk.group}/${rk.version}` : `/api/${rk.version}`;
  const path = rk.namespaced
    ? `${base}/namespaces/${childNamespace}/${rk.plural}/${ref.name}`
    : `${base}/${rk.plural}/${ref.name}`;
  try {
    const it = await request(path);
    if (!it?.metadata) return null;
    return {
      ...it,
      kind: it.kind || rk.kind,
      apiVersion: it.apiVersion || (rk.group ? `${rk.group}/${rk.version}` : rk.version),
      group: rk.group,
      plural: rk.plural,
    };
  } catch (e) {
    return null; // 403 / 404 — skip
  }
}

/**
 * Ownership edges for workload children (Pods, ReplicaSets) — the links that
 * connect an unlabelled pod up to its labelled controller. ownerReferences are
 * immutable for an object's lifetime, so these RELATIONS are cached far longer
 * than the app data; only edges + identity are kept here, never bodies.
 */
interface ChildRel {
  ownerRefs: any[];
  kind: string;
  group: string;
  version: string;
  plural: string;
  namespace?: string;
  name: string;
}

const CHILD_KINDS = [
  { base: '/api/v1', kind: 'Pod', group: '', version: 'v1', plural: 'pods' },
  { base: '/apis/apps/v1', kind: 'ReplicaSet', group: 'apps', version: 'v1', plural: 'replicasets' },
];

let relationCache: { at: number; rels: Map<string, ChildRel> } | null = null;
const RELATION_TTL_MS = 10 * 60_000; // ownerReferences never change; refresh occasionally

async function childRelations(force = false): Promise<Map<string, ChildRel>> {
  if (!force && relationCache && Date.now() - relationCache.at < RELATION_TTL_MS) {
    return relationCache.rels;
  }
  const rels = new Map<string, ChildRel>();
  await pMap(
    CHILD_KINDS,
    async k => {
      try {
        const resp = await request(`${k.base}/${k.plural}`);
        for (const it of resp?.items ?? []) {
          const uid = it.metadata?.uid;
          if (!uid) continue;
          if (isRolloutHistory({ ...it, kind: it.kind || k.kind } as AppResource)) continue;
          rels.set(uid, {
            ownerRefs: it.metadata?.ownerReferences ?? [],
            kind: k.kind,
            group: k.group,
            version: k.version,
            plural: k.plural,
            namespace: it.metadata?.namespace,
            name: it.metadata?.name,
          });
        }
      } catch (e) {
        // not listable for us — skip
      }
    },
    CHILD_KINDS.length
  );
  relationCache = { at: Date.now(), rels };
  return rels;
}

/** Fetch one namespaced object's current body by identity (for a child we attach). */
async function fetchBody(r: ChildRel): Promise<AppResource | null> {
  const base = r.group ? `/apis/${r.group}/${r.version}` : `/api/${r.version}`;
  try {
    const it = await request(`${base}/namespaces/${r.namespace}/${r.plural}/${r.name}`);
    if (!it?.metadata) return null;
    return {
      ...it,
      kind: it.kind || r.kind,
      apiVersion: it.apiVersion || (r.group ? `${r.group}/${r.version}` : r.version),
      group: r.group,
      plural: r.plural,
    };
  } catch (e) {
    return null;
  }
}

let appsCache: { at: number; data: Map<string, AppResource[]> } | null = null;
const OWNER_FETCH_BUDGET = 200; // total up-owner fetches per build, a runaway guard

interface GraphNode {
  ownerRefs: any[];
  ns?: string;
  app?: string; // set when the object itself carries the instance label
  res?: AppResource; // the body, when we have one
  rel?: ChildRel; // identity to fetch a body on demand (down-children)
}

/**
 * The apps, keyed by instance label. Each is enriched by resolving the ownership
 * graph in BOTH directions: unlabelled parents above labelled resources (a CNPG
 * Cluster over labelled pods) and unlabelled children below them (a labelled
 * Deployment's pods). An unlabelled object is attached to an app only if its
 * ownership component resolves to exactly ONE app — if two apps reach it, it's
 * ambiguous and dropped. Resolution is a union-find over the edges, so a cycle
 * just collapses into one component (no recursion, O(V+E), can't loop).
 */
export async function listApps(force = false): Promise<Map<string, AppResource[]>> {
  if (!force && appsCache && Date.now() - appsCache.at < INSTANCES_TTL_MS) {
    return appsCache.data;
  }

  const labelled = await listInstances(force);
  const childRels = await childRelations(force);

  const nodes = new Map<string, GraphNode>();
  const ensure = (uid: string): GraphNode => {
    let n = nodes.get(uid);
    if (!n) {
      n = { ownerRefs: [] };
      nodes.set(uid, n);
    }
    return n;
  };

  // Labelled resources: body + app, from the fresh sweep.
  for (const r of labelled) {
    if (isRolloutHistory(r)) continue;
    const app = instanceOf(r);
    const uid = r.metadata?.uid;
    if (!app || !uid) continue;
    const n = ensure(uid);
    n.app = app;
    n.res = r;
    n.ns = r.metadata?.namespace;
    n.ownerRefs = r.metadata?.ownerReferences ?? [];
  }

  // Workload children: ownership edges only (bodies fetched later iff attached).
  for (const [uid, rel] of childRels) {
    const n = ensure(uid);
    if (!n.ownerRefs.length) n.ownerRefs = rel.ownerRefs;
    if (n.ns === undefined) n.ns = rel.namespace;
    if (!n.rel) n.rel = rel;
  }

  // Up-owners: fetch owners referenced by known nodes but not yet present (e.g. a
  // CNPG Cluster). Each uid is fetched at most once, so a reference cycle can't
  // spin — the nodes map is the visited set.
  let budget = OWNER_FETCH_BUDGET;
  let frontier = [...nodes.keys()];
  while (frontier.length && budget > 0) {
    const wanted = new Map<string, { ref: any; ns?: string }>();
    for (const uid of frontier) {
      const n = nodes.get(uid)!;
      for (const ref of n.ownerRefs) {
        if (ref?.uid && !nodes.has(ref.uid) && !wanted.has(ref.uid)) {
          wanted.set(ref.uid, { ref, ns: n.ns });
        }
      }
    }
    if (!wanted.size) break;
    const items = [...wanted.values()].slice(0, budget);
    budget -= items.length;
    const fetched = await pMap(items, t => fetchOwner(t.ref, t.ns), 10);
    const next: string[] = [];
    for (const owner of fetched) {
      const uid = owner?.metadata?.uid;
      if (!owner || !uid || nodes.get(uid)?.res) continue;
      const n = ensure(uid);
      n.res = owner;
      n.app = instanceOf(owner);
      n.ns = owner.metadata?.namespace;
      n.ownerRefs = owner.metadata?.ownerReferences ?? [];
      next.push(uid);
    }
    frontier = next;
  }

  // Resolve every node to its app — pure union-find over the ownership edges
  // (cycle-safe; see resolveOwnership). Unlabelled nodes get an app only if their
  // component maps to exactly one; ambiguous or app-less -> null (dropped).
  const view = new Map<string, OwnershipNode>();
  for (const [uid, n] of nodes) view.set(uid, { ownerRefs: n.ownerRefs, app: n.app });
  const resolved = resolveOwnership(view);

  const groups = new Map<string, AppResource[]>();
  const push = (app: string, res: AppResource) => {
    let l = groups.get(app);
    if (!l) {
      l = [];
      groups.set(app, l);
    }
    l.push(res);
  };

  // Attach bodies we already have; queue fetches for attached children we only
  // had edges for (the few unlabelled workload children below a labelled owner).
  const toFetch: { app: string; rel: ChildRel }[] = [];
  for (const [uid, n] of nodes) {
    const app = resolved.get(uid);
    if (!app) continue; // null -> ambiguous or app-less -> drop
    if (n.res) push(app, n.res);
    else if (n.rel) toFetch.push({ app, rel: n.rel });
  }
  const bodies = await pMap(toFetch, t => fetchBody(t.rel).then(b => ({ app: t.app, b })), 10);
  for (const { app, b } of bodies) if (b) push(app, b);

  appsCache = { at: Date.now(), data: groups };
  return groups;
}

export function instanceOf(r: AppResource): string | undefined {
  return r.metadata?.labels?.[INSTANCE_LABEL];
}

/**
 * Rollout-history bookkeeping that clutters an app view rather than describing
 * it: a superseded ReplicaSet (an old Deployment revision, scaled to 0/0 with no
 * live pods) or a ControllerRevision (StatefulSet/DaemonSet revision snapshots).
 * Kubernetes keeps up to revisionHistoryLimit of these for rollback; they aren't
 * something you manage per-app, so we drop them.
 */
function isRolloutHistory(r: AppResource): boolean {
  if (r.kind === 'ControllerRevision') return true;
  return (
    r.kind === 'ReplicaSet' &&
    (r.spec?.replicas ?? 0) === 0 &&
    (r.status?.replicas ?? 0) === 0
  );
}

function firstLabel(resources: AppResource[], label: string): string | undefined {
  for (const r of resources) {
    const v = r.metadata?.labels?.[label];
    if (v) return v;
  }
  return undefined;
}

/** Ready if the pod's Ready condition is True (fallback: all containers ready). */
export function isPodReady(pod: AppResource): boolean {
  const conds = pod.status?.conditions ?? [];
  const ready = conds.find((c: any) => c.type === 'Ready');
  if (ready) return ready.status === 'True';
  const cs = pod.status?.containerStatuses ?? [];
  return cs.length > 0 && cs.every((c: any) => c.ready);
}

function podIsBroken(pod: AppResource): boolean {
  if (pod.status?.phase === 'Failed') return true;
  const cs = pod.status?.containerStatuses ?? [];
  return cs.some(
    (c: any) =>
      c.state?.waiting?.reason === 'CrashLoopBackOff' ||
      c.state?.waiting?.reason === 'ImagePullBackOff' ||
      c.state?.waiting?.reason === 'ErrImagePull'
  );
}

/** An app entry point: the full URL (host + path, for the link) and the host (compact label). */
export interface IngressUrl {
  url: string;
  host: string;
}

/**
 * Ingress rules → entry-point URLs (best-effort, https). The link target keeps
 * the ingress path when it's a real subpath (so it opens the right place), but
 * the label stays the bare host to keep table rows compact. One URL per host:
 * the root if the ingress serves `/`, otherwise its first non-root path.
 */
export function ingressUrls(resources: AppResource[]): IngressUrl[] {
  const seen = new Set<string>();
  const out: IngressUrl[] = [];
  for (const r of resources) {
    if (r.kind !== 'Ingress') continue;
    for (const rule of r.spec?.rules ?? []) {
      if (!rule.host) continue;
      const paths = (rule.http?.paths ?? []).map((p: any) => p.path).filter(Boolean) as string[];
      const hasRoot = paths.length === 0 || paths.some(p => p === '/');
      const path = hasRoot ? '' : paths[0];
      const url = `https://${rule.host}${path}`;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, host: rule.host });
    }
  }
  return out;
}

export type Health = 'Healthy' | 'Progressing' | 'Degraded' | 'Unknown';

export interface AppSummary {
  name: string;
  version?: string;
  resourceCount: number;
  podsTotal: number;
  podsReady: number;
  ingressUrls: IngressUrl[];
  namespaces: string[];
  health: Health;
  oldest?: string;
}

type Signal = 'ok' | 'progressing' | 'broken';

/**
 * Health signal from a workload controller's ready/desired counts. Returns null
 * for kinds we don't rate or ones scaled to zero (no signal). Lets an app read
 * healthy from e.g. a Deployment even when its pods aren't in the app group
 * (unlabelled pod templates).
 */
function workloadSignal(r: AppResource): Signal | null {
  let desired: number | undefined;
  let ready: number | undefined;
  switch (r.kind) {
    case 'Deployment':
      desired = r.spec?.replicas ?? 1;
      ready = r.status?.availableReplicas ?? 0;
      break;
    case 'StatefulSet':
      desired = r.spec?.replicas ?? 1;
      ready = r.status?.readyReplicas ?? 0;
      break;
    case 'DaemonSet':
      desired = r.status?.desiredNumberScheduled ?? 0;
      ready = r.status?.numberReady ?? 0;
      break;
    default:
      return null;
  }
  if (!desired) return null; // scaled to zero — not a health signal
  return ready === 0 ? 'broken' : ready < desired ? 'progressing' : 'ok';
}

/** Health signal from a single pod. Completed pods (Succeeded, e.g. a Job) don't count. */
function podSignal(pod: AppResource): Signal | null {
  if (pod.status?.phase === 'Succeeded') return null;
  if (podIsBroken(pod)) return 'broken';
  return isPodReady(pod) ? 'ok' : 'progressing';
}

/** Roll a set of an app's resources up into the summary shown on the Apps list. */
export function summarize(name: string, resources: AppResource[]): AppSummary {
  const pods = resources.filter(r => r.kind === 'Pod');
  const podsReady = pods.filter(isPodReady).length;
  const namespaces = Array.from(
    new Set(resources.map(r => r.metadata?.namespace).filter(Boolean) as string[])
  );

  const timestamps = resources.map(r => r.metadata?.creationTimestamp).filter(Boolean) as string[];
  const oldest = timestamps.length ? timestamps.reduce((a, b) => (a < b ? a : b)) : undefined;

  // Health rollup: prefer workload controllers (Deployment/StatefulSet/DaemonSet)
  // — their ready/desired already accounts for pod health — and fall back to raw
  // pod status only when the app has no such controller (e.g. CNPG-managed pods).
  // Worst signal wins: any broken -> Degraded, any not-ready -> Progressing,
  // all ready -> Healthy, nothing to rate -> Unknown.
  const controllerSignals = resources
    .map(workloadSignal)
    .filter((s): s is Signal => s !== null);
  const signals = controllerSignals.length
    ? controllerSignals
    : pods.map(podSignal).filter((s): s is Signal => s !== null);
  let health: Health = 'Unknown';
  if (signals.length > 0) {
    if (signals.includes('broken')) health = 'Degraded';
    else if (signals.includes('progressing')) health = 'Progressing';
    else health = 'Healthy';
  }

  return {
    name,
    version: firstLabel(resources, VERSION_LABEL),
    resourceCount: resources.length,
    podsTotal: pods.length,
    podsReady,
    ingressUrls: ingressUrls(resources),
    namespaces,
    health,
    oldest,
  };
}

/** Group an app's resources by kind (for the per-kind sections on the detail page). */
export function groupByKind(resources: AppResource[]): Record<string, AppResource[]> {
  const groups: Record<string, AppResource[]> = {};
  for (const r of resources) {
    (groups[r.kind] ||= []).push(r);
  }
  return groups;
}

/**
 * Preferred order for the per-kind sections on the detail page: what you most
 * want to see first — the workloads and their pods, then how they're reached,
 * then their config/storage, then policy and RBAC. Kinds not listed here are
 * appended alphabetically. Edit this list to reorder; it's the single source.
 */
export const PREFERRED_KIND_ORDER = [
  // primary workloads
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  // running instances
  'Pod',
  // secondary workloads
  'ReplicaSet',
  'CronJob',
  'Job',
  // networking / how the app is reached
  'Service',
  'Ingress',
  'IngressRoute',
  'HTTPRoute',
  'Endpoints',
  'EndpointSlice',
  // config & storage
  'ConfigMap',
  'Secret',
  'PersistentVolumeClaim',
  // scaling & disruption
  'HorizontalPodAutoscaler',
  'PodDisruptionBudget',
  // identity & RBAC
  'ServiceAccount',
  'Role',
  'RoleBinding',
  'ClusterRole',
  'ClusterRoleBinding',
];

/** Order kinds by PREFERRED_KIND_ORDER first, then everything else alphabetically. */
export function orderKinds(kinds: string[]): string[] {
  const rank = new Map(PREFERRED_KIND_ORDER.map((k, i) => [k, i]));
  return [...kinds].sort((a, b) => {
    const ra = rank.has(a) ? rank.get(a)! : Infinity;
    const rb = rank.has(b) ? rank.get(b)! : Infinity;
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
}
