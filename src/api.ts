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

/** Roll a set of an app's resources up into the summary shown on the Apps list. */
export function summarize(name: string, resources: AppResource[]): AppSummary {
  const pods = resources.filter(r => r.kind === 'Pod');
  const podsReady = pods.filter(isPodReady).length;
  const namespaces = Array.from(
    new Set(resources.map(r => r.metadata?.namespace).filter(Boolean) as string[])
  );

  const timestamps = resources.map(r => r.metadata?.creationTimestamp).filter(Boolean) as string[];
  const oldest = timestamps.length ? timestamps.reduce((a, b) => (a < b ? a : b)) : undefined;

  // Health rollup: broken pods -> Degraded; not-all-ready pods -> Progressing; else Healthy.
  let health: Health = 'Unknown';
  if (pods.length > 0) {
    if (pods.some(podIsBroken)) health = 'Degraded';
    else if (podsReady < pods.length) health = 'Progressing';
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
