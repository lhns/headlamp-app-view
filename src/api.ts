/*
 * Copyright 2026 Pierre Kisters
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runtime discovery of every listable resource kind (built-ins + CRDs) and
 * label-filtered listing, so an "app" can be assembled from all of its resources.
 */
import { request } from '@kinvolk/headlamp-plugin/lib/ApiProxy';

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

  try {
    const groups = await request('/apis');
    await Promise.all(
      (groups?.groups ?? []).map(async (g: any) => {
        const gv: string | undefined =
          g.preferredVersion?.groupVersion || g.versions?.[0]?.groupVersion;
        if (!gv || !gv.includes('/')) return;
        const [group, version] = gv.split('/');
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

const ownerCache = new Map<string, AppResource | null>();

/** Fetch a single object referenced by an ownerReference; null if gone/unreadable. Cached by path. */
async function fetchOwner(ref: any, childNamespace?: string): Promise<AppResource | null> {
  if (!ref?.kind || !ref?.name) return null;
  const rk = await resolveKind(ref.apiVersion || 'v1', ref.kind);
  if (!rk) return null;
  const base = rk.group ? `/apis/${rk.group}/${rk.version}` : `/api/${rk.version}`;
  const path = rk.namespaced
    ? `${base}/namespaces/${childNamespace}/${rk.plural}/${ref.name}`
    : `${base}/${rk.plural}/${ref.name}`;
  if (ownerCache.has(path)) return ownerCache.get(path)!;

  let obj: AppResource | null = null;
  try {
    const it = await request(path);
    if (it?.metadata) {
      obj = {
        ...it,
        kind: it.kind || rk.kind,
        apiVersion: it.apiVersion || (rk.group ? `${rk.group}/${rk.version}` : rk.version),
        group: rk.group,
        plural: rk.plural,
      };
    }
  } catch (e) {
    obj = null; // 403 / 404 — skip
  }
  ownerCache.set(path, obj);
  return obj;
}

let appsCache: { at: number; data: Map<string, AppResource[]> } | null = null;
const OWNER_WALK_BUDGET = 50; // max owner fetches per app, a runaway guard

/**
 * The apps, keyed by instance label, each enriched by walking ownerReferences
 * upward to include unlabelled parents (e.g. a CNPG Cluster owning labelled
 * pods). Owners already present via their own label are not refetched.
 */
export async function listApps(force = false): Promise<Map<string, AppResource[]>> {
  if (!force && appsCache && Date.now() - appsCache.at < INSTANCES_TTL_MS) {
    return appsCache.data;
  }

  const resources = await listInstances(force);
  const groups = new Map<string, AppResource[]>();
  const seen = new Set<string>(); // uids already attributed to some app

  for (const r of resources) {
    const app = instanceOf(r);
    if (!app) continue;
    if (r.metadata?.uid) seen.add(r.metadata.uid);
    const list = groups.get(app) ?? [];
    if (!groups.has(app)) groups.set(app, list);
    list.push(r);
  }

  for (const list of groups.values()) {
    const queue = [...list];
    let budget = OWNER_WALK_BUDGET;
    while (queue.length && budget > 0) {
      const cur = queue.shift()!;
      for (const ref of cur.metadata?.ownerReferences ?? []) {
        if (ref.uid && seen.has(ref.uid)) continue; // already have it (likely labelled itself)
        if (budget <= 0) break;
        budget--;
        const owner = await fetchOwner(ref, cur.metadata?.namespace);
        const ouid = owner?.metadata?.uid;
        if (!owner || (ouid && seen.has(ouid))) {
          if (ref.uid) seen.add(ref.uid);
          continue;
        }
        if (ouid) seen.add(ouid);
        list.push(owner);
        queue.push(owner); // keep walking up (parent's parent, …)
      }
    }
  }

  appsCache = { at: Date.now(), data: groups };
  return groups;
}

export function instanceOf(r: AppResource): string | undefined {
  return r.metadata?.labels?.[INSTANCE_LABEL];
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

/** Ingress hosts → https URLs (best-effort). */
export function ingressUrls(resources: AppResource[]): string[] {
  const urls = new Set<string>();
  for (const r of resources) {
    if (r.kind !== 'Ingress') continue;
    for (const rule of r.spec?.rules ?? []) {
      if (rule.host) urls.add(`https://${rule.host}`);
    }
  }
  return Array.from(urls);
}

export type Health = 'Healthy' | 'Progressing' | 'Degraded' | 'Unknown';

export interface AppSummary {
  name: string;
  version?: string;
  resourceCount: number;
  podsTotal: number;
  podsReady: number;
  ingressUrls: string[];
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
