/*
 * Copyright 2026 Pierre Kisters
 * SPDX-License-Identifier: Apache-2.0
 *
 * Per-kind column sets for the detail page, mirroring the columns Headlamp's own
 * resource lists show (Deployment ready/up-to-date, Service type/IP/ports, …),
 * with a generic fallback for kinds we don't have a specific set for.
 */
import { DateLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import React from 'react';
import { AppResource, Health } from './api';
import { NamespaceLink, ResourceLink } from './links';

export interface Column {
  label: string;
  getter: (r: AppResource) => React.ReactNode;
  /** Grid track for this column (SimpleTable's `gridTemplate`). */
  gridTemplate?: number | string;
}

/*
 * SimpleTable lays each column out as a CSS-grid track (`gridTemplate`), defaulting
 * to `1fr` — with no floor, columns squish to unreadable widths and wrap. `minmax()`
 * gives a real minimum while still flexing via the fr weight. When the minimums sum
 * past the viewport the table scrolls horizontally *inside its own container*
 * (SimpleTable wraps the grid in an `overflow-x: auto` TableContainer), so the page
 * layout never breaks.
 */
export const TRACK = {
  name: 'minmax(180px, 2fr)',
  namespace: 'minmax(120px, 1.2fr)',
  wide: 'minmax(160px, 1.6fr)', // ports, hosts, URLs — can be long
  age: 'minmax(96px, 0.7fr)',
};
const DEFAULT_TRACK = 'minmax(100px, 1fr)';

/** Give every column a minimum width, defaulting the ones that didn't set one. */
export function fillTracks<T extends { gridTemplate?: number | string }>(cols: T[]): T[] {
  return cols.map(c => (c.gridTemplate === undefined ? { ...c, gridTemplate: DEFAULT_TRACK } : c));
}

export function healthStatus(h: Health): 'success' | 'warning' | 'error' | '' {
  switch (h) {
    case 'Healthy':
      return 'success';
    case 'Progressing':
      return 'warning';
    case 'Degraded':
      return 'error';
    default:
      return '';
  }
}

/** Best-effort readiness text for any resource (used by the generic fallback). */
export function readyText(r: AppResource): string {
  const conds = r.status?.conditions ?? [];
  const ready = conds.find((c: any) => ['Ready', 'Available', 'Established'].includes(c.type));
  if (ready) return ready.status;
  if (r.status?.readyReplicas !== undefined || r.spec?.replicas !== undefined) {
    return `${r.status?.readyReplicas ?? 0}/${r.spec?.replicas ?? 0}`;
  }
  if (r.status?.numberReady !== undefined && r.status?.desiredNumberScheduled !== undefined) {
    return `${r.status.numberReady}/${r.status.desiredNumberScheduled}`;
  }
  if (r.kind === 'Pod') {
    const cs = r.status?.containerStatuses ?? [];
    if (cs.length) return `${cs.filter((c: any) => c.ready).length}/${cs.length}`;
  }
  return '';
}

const nameCol: Column = {
  label: 'Name',
  getter: r => <ResourceLink item={r} />,
  gridTemplate: TRACK.name,
};
const nsCol: Column = {
  label: 'Namespace',
  getter: r => (r.metadata?.namespace ? <NamespaceLink name={r.metadata.namespace} /> : '—'),
  gridTemplate: TRACK.namespace,
};
const ageCol: Column = {
  label: 'Age',
  getter: r =>
    r.metadata?.creationTimestamp ? <DateLabel date={r.metadata.creationTimestamp} /> : '—',
  gridTemplate: TRACK.age,
};

const dash = (v: React.ReactNode) => (v === undefined || v === null || v === '' ? '—' : v);

/** Pod phase / most interesting container-waiting reason. */
function podStatus(r: AppResource): string {
  const cs = r.status?.containerStatuses ?? [];
  const waiting = cs.map((c: any) => c.state?.waiting?.reason).find(Boolean);
  const terminated = cs.map((c: any) => c.state?.terminated?.reason).find((x: string) => x && x !== 'Completed');
  return waiting || terminated || r.status?.phase || '';
}

function podRestarts(r: AppResource): number {
  const cs = r.status?.containerStatuses ?? [];
  return cs.reduce((n: number, c: any) => n + (c.restartCount ?? 0), 0);
}

function servicePorts(r: AppResource): string {
  return (r.spec?.ports ?? [])
    .map((p: any) => `${p.port}${p.protocol && p.protocol !== 'TCP' ? '/' + p.protocol : ''}`)
    .join(', ');
}

function ingressHosts(r: AppResource): string {
  return (r.spec?.rules ?? []).map((ru: any) => ru.host).filter(Boolean).join(', ');
}

function keyCount(obj: any): number {
  return obj ? Object.keys(obj).length : 0;
}

/** Kinds with a tailored column set; everything else uses the generic fallback. */
const BY_KIND: Record<string, Column[]> = {
  Pod: [
    nameCol,
    nsCol,
    {
      label: 'Ready',
      getter: r => {
        const cs = r.status?.containerStatuses ?? [];
        return cs.length ? `${cs.filter((c: any) => c.ready).length}/${cs.length}` : '—';
      },
    },
    { label: 'Status', getter: r => dash(podStatus(r)) },
    { label: 'Restarts', getter: r => podRestarts(r) },
    { label: 'Node', getter: r => dash(r.spec?.nodeName) },
    ageCol,
  ],
  Deployment: [
    nameCol,
    nsCol,
    { label: 'Ready', getter: r => `${r.status?.readyReplicas ?? 0}/${r.spec?.replicas ?? 0}` },
    { label: 'Up-to-date', getter: r => r.status?.updatedReplicas ?? 0 },
    { label: 'Available', getter: r => r.status?.availableReplicas ?? 0 },
    ageCol,
  ],
  StatefulSet: [
    nameCol,
    nsCol,
    { label: 'Ready', getter: r => `${r.status?.readyReplicas ?? 0}/${r.spec?.replicas ?? 0}` },
    ageCol,
  ],
  ReplicaSet: [
    nameCol,
    nsCol,
    { label: 'Ready', getter: r => `${r.status?.readyReplicas ?? 0}/${r.spec?.replicas ?? 0}` },
    ageCol,
  ],
  DaemonSet: [
    nameCol,
    nsCol,
    {
      label: 'Ready',
      getter: r => `${r.status?.numberReady ?? 0}/${r.status?.desiredNumberScheduled ?? 0}`,
    },
    ageCol,
  ],
  Job: [
    nameCol,
    nsCol,
    { label: 'Completions', getter: r => `${r.status?.succeeded ?? 0}/${r.spec?.completions ?? 1}` },
    ageCol,
  ],
  CronJob: [
    nameCol,
    nsCol,
    { label: 'Schedule', getter: r => dash(r.spec?.schedule) },
    { label: 'Suspend', getter: r => (r.spec?.suspend ? 'true' : 'false') },
    ageCol,
  ],
  Service: [
    nameCol,
    nsCol,
    { label: 'Type', getter: r => dash(r.spec?.type) },
    { label: 'Cluster IP', getter: r => dash(r.spec?.clusterIP) },
    { label: 'Ports', getter: r => dash(servicePorts(r)), gridTemplate: TRACK.wide },
    ageCol,
  ],
  Ingress: [
    nameCol,
    nsCol,
    { label: 'Class', getter: r => dash(r.spec?.ingressClassName) },
    { label: 'Hosts', getter: r => dash(ingressHosts(r)), gridTemplate: TRACK.wide },
    ageCol,
  ],
  PersistentVolumeClaim: [
    nameCol,
    nsCol,
    { label: 'Status', getter: r => dash(r.status?.phase) },
    { label: 'Capacity', getter: r => dash(r.status?.capacity?.storage) },
    { label: 'StorageClass', getter: r => dash(r.spec?.storageClassName) },
    ageCol,
  ],
  ConfigMap: [nameCol, nsCol, { label: 'Data', getter: r => keyCount(r.data) }, ageCol],
  Secret: [
    nameCol,
    nsCol,
    { label: 'Type', getter: r => dash(r.type) },
    { label: 'Data', getter: r => keyCount(r.data) },
    ageCol,
  ],
  ServiceAccount: [
    nameCol,
    nsCol,
    { label: 'Secrets', getter: r => (r.secrets?.length ?? 0) as number },
    ageCol,
  ],
};

/** Generic columns for kinds without a tailored set (incl. custom resources). */
const GENERIC: Column[] = [
  nameCol,
  nsCol,
  { label: 'Ready', getter: r => dash(readyText(r)) },
  ageCol,
];

export function columnsForKind(kind: string): Column[] {
  return BY_KIND[kind] ?? GENERIC;
}

/** Kinds we render namespace-less (cluster-scoped): drop the Namespace column if all rows lack one. */
export function columnsForRows(kind: string, rows: AppResource[]): Column[] {
  const cols = columnsForKind(kind);
  const anyNamespaced = rows.some(r => r.metadata?.namespace);
  return fillTracks(anyNamespaced ? cols : cols.filter(c => c.label !== 'Namespace'));
}
