/*
 * Copyright 2026 Pierre Kisters
 * SPDX-License-Identifier: Apache-2.0
 *
 * headlamp-app-view — an application-centric view for Headlamp. Adds an "Apps"
 * sidebar entry: a list of apps (grouped by app.kubernetes.io/instance) and a
 * per-app page listing every resource kind (incl. CRDs) the app owns.
 */
import { registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { AppDetail } from './AppDetail';
import { AppsList } from './AppsList';

registerSidebarEntry({
  parent: null,
  name: 'apps',
  label: 'Apps',
  url: '/apps',
  icon: 'mdi:apps',
});

registerRoute({
  path: '/apps',
  sidebar: 'apps',
  name: 'apps',
  exact: true,
  component: AppsList,
});

registerRoute({
  path: '/apps/:name',
  sidebar: 'apps',
  name: 'app-detail',
  exact: true,
  component: AppDetail,
});
