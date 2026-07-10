/*
 * Copyright 2026 Pierre Kisters
 * SPDX-License-Identifier: Apache-2.0
 *
 * The "Apps" list: sweeps all kinds for objects carrying app.kubernetes.io/instance,
 * groups them by that label, and shows one summary row per app.
 */
import {
  DateLabel,
  Link,
  Loader,
  SectionBox,
  SimpleTable,
  StatusLabel,
} from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Link as MuiLink } from '@mui/material';
import React from 'react';
import {
  AppResource,
  AppSummary,
  Health,
  INSTANCE_LABEL,
  instanceOf,
  listAll,
  summarize,
} from './api';

function healthStatus(h: Health): 'success' | 'warning' | 'error' | '' {
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

export function AppsList() {
  const [apps, setApps] = React.useState<AppSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    listAll(INSTANCE_LABEL)
      .then(resources => {
        if (cancelled) return;
        const byApp: Record<string, AppResource[]> = {};
        for (const r of resources) {
          const app = instanceOf(r);
          if (!app) continue;
          (byApp[app] ||= []).push(r);
        }
        const summaries = Object.entries(byApp)
          .map(([name, res]) => summarize(name, res))
          .sort((a, b) => a.name.localeCompare(b.name));
        setApps(summaries);
      })
      .catch(e => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SectionBox title="Apps" textAlign="left">
      {error ? (
        <Box color="error.main">Failed to load apps: {error}</Box>
      ) : apps === null ? (
        <Loader title="Loading apps…" />
      ) : (
        <SimpleTable
          emptyMessage={`No resources labelled ${INSTANCE_LABEL} were found.`}
          columns={[
            {
              label: 'App',
              getter: (a: AppSummary) => (
                <Link routeName="app-detail" params={{ name: a.name }}>
                  {a.name}
                </Link>
              ),
            },
            { label: 'Version', getter: (a: AppSummary) => a.version ?? '—' },
            {
              label: 'Health',
              getter: (a: AppSummary) => (
                <StatusLabel status={healthStatus(a.health)}>{a.health}</StatusLabel>
              ),
            },
            {
              label: 'Pods',
              getter: (a: AppSummary) => (a.podsTotal ? `${a.podsReady}/${a.podsTotal}` : '—'),
            },
            { label: 'Resources', getter: (a: AppSummary) => a.resourceCount },
            {
              label: 'URL',
              getter: (a: AppSummary) =>
                a.ingressUrls.length ? (
                  <Box>
                    {a.ingressUrls.map(u => (
                      <Box key={u}>
                        <MuiLink href={u} target="_blank" rel="noopener noreferrer">
                          {u.replace(/^https?:\/\//, '')}
                        </MuiLink>
                      </Box>
                    ))}
                  </Box>
                ) : (
                  '—'
                ),
            },
            { label: 'Namespace', getter: (a: AppSummary) => a.namespaces.join(', ') || '—' },
            {
              label: 'Age',
              getter: (a: AppSummary) => (a.oldest ? <DateLabel date={a.oldest} /> : '—'),
            },
          ]}
          data={apps}
        />
      )}
    </SectionBox>
  );
}
