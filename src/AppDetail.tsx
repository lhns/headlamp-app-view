/*
 * Copyright 2026 Pierre Kisters
 * SPDX-License-Identifier: Apache-2.0
 *
 * The per-app page: sweeps all kinds for objects of one app
 * (app.kubernetes.io/instance=<name>) and renders one section per kind.
 */
import {
  DateLabel,
  Loader,
  SectionBox,
  SimpleTable,
} from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box } from '@mui/material';
import React from 'react';
import { useParams } from 'react-router-dom';
import { AppResource, groupByKind, listApps, orderKinds } from './api';
import { ResourceLink } from './links';

/** Best-effort readiness text for any resource. */
function readyText(r: AppResource): string {
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

export function AppDetail() {
  const { name } = useParams<{ name: string }>();
  const [resources, setResources] = React.useState<AppResource[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setResources(null);
    setError(null);
    listApps()
      .then(groups => !cancelled && setResources(groups.get(name!) ?? []))
      .catch(e => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [name]);

  if (error) {
    return (
      <SectionBox title={name} textAlign="left">
        <Box color="error.main">Failed to load: {error}</Box>
      </SectionBox>
    );
  }
  if (resources === null) {
    return (
      <SectionBox title={name} textAlign="left">
        <Loader title="Loading app resources…" />
      </SectionBox>
    );
  }

  const groups = groupByKind(resources);
  const kinds = orderKinds(Object.keys(groups));

  return (
    <Box sx={{ pb: 3 }}>
      <SectionBox title={`App: ${name}`} textAlign="left">
        <Box>
          {resources.length} resource{resources.length === 1 ? '' : 's'} across {kinds.length} kind
          {kinds.length === 1 ? '' : 's'}
        </Box>
      </SectionBox>
      {kinds.map(kind => (
        <SectionBox key={kind} title={`${kind} (${groups[kind].length})`} textAlign="left">
          <SimpleTable
            rowsPerPage={[50, 100]}
            columns={[
              { label: 'Name', getter: (r: AppResource) => <ResourceLink item={r} /> },
              { label: 'Namespace', getter: (r: AppResource) => r.metadata?.namespace ?? '—' },
              { label: 'Ready', getter: (r: AppResource) => readyText(r) || '—' },
              {
                label: 'Age',
                getter: (r: AppResource) =>
                  r.metadata?.creationTimestamp ? (
                    <DateLabel date={r.metadata.creationTimestamp} />
                  ) : (
                    '—'
                  ),
              },
            ]}
            data={groups[kind]}
          />
        </SectionBox>
      ))}
    </Box>
  );
}
