/*
 * Copyright 2026 Pierre Kisters
 * SPDX-License-Identifier: Apache-2.0
 *
 * The per-app page: a summary header (the same facts the Apps list shows) plus
 * one section per resource kind, each with kind-appropriate columns.
 */
import { Router } from '@kinvolk/headlamp-plugin/lib';
import {
  DateLabel,
  Loader,
  NameValueTable,
  SectionBox,
  SimpleTable,
  StatusLabel,
} from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Link as MuiLink } from '@mui/material';
import React from 'react';
import { useParams } from 'react-router-dom';
import { AppResource, groupByKind, listApps, orderKinds, summarize } from './api';
import { columnsForRows, healthStatus } from './columns';
import { NamespaceLinks } from './links';

const appsListUrl = Router.createRouteURL('apps');

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
      <SectionBox title={name} textAlign="left" backLink={appsListUrl}>
        <Box color="error.main">Failed to load: {error}</Box>
      </SectionBox>
    );
  }
  if (resources === null) {
    return (
      <SectionBox title={name} textAlign="left" backLink={appsListUrl}>
        <Loader title="Loading app resources…" />
      </SectionBox>
    );
  }

  const summary = summarize(name!, resources);
  const groups = groupByKind(resources);
  const kinds = orderKinds(Object.keys(groups));

  const summaryRows = [
    {
      name: 'Health',
      value: <StatusLabel status={healthStatus(summary.health)}>{summary.health}</StatusLabel>,
    },
    { name: 'Version', value: summary.version ?? '—' },
    {
      name: 'Pods',
      value: summary.podsTotal ? `${summary.podsReady}/${summary.podsTotal}` : '—',
    },
    { name: 'Resources', value: String(summary.resourceCount) },
    { name: 'Namespaces', value: <NamespaceLinks names={summary.namespaces} /> },
    {
      name: 'URL',
      value: summary.ingressUrls.length ? (
        <Box>
          {summary.ingressUrls.map(u => (
            <Box key={u.url}>
              <MuiLink href={u.url} target="_blank" rel="noopener noreferrer">
                {u.host}
              </MuiLink>
            </Box>
          ))}
        </Box>
      ) : (
        '—'
      ),
    },
    {
      name: 'Age',
      value: summary.oldest ? <DateLabel date={summary.oldest} /> : '—',
    },
  ];

  return (
    <Box sx={{ pb: 3 }}>
      <SectionBox title={`App: ${name}`} textAlign="left" backLink={appsListUrl}>
        <NameValueTable rows={summaryRows} />
      </SectionBox>
      {kinds.map(kind => (
        <SectionBox key={kind} title={`${kind} (${groups[kind].length})`} textAlign="left">
          <SimpleTable rowsPerPage={[50, 100]} columns={columnsForRows(kind, groups[kind])} data={groups[kind]} />
        </SectionBox>
      ))}
    </Box>
  );
}
