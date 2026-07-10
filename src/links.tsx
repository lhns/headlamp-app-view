/*
 * Copyright 2026 Pierre Kisters
 * SPDX-License-Identifier: Apache-2.0
 */
import { K8s } from '@kinvolk/headlamp-plugin/lib';
import { Link } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import React from 'react';
import { AppResource } from './api';

/** Link to a namespace's details page. */
export function NamespaceLink({ name }: { name: string }): React.ReactElement {
  return (
    <Link routeName="namespace" params={{ name }}>
      {name}
    </Link>
  );
}

/** A comma-separated list of namespace links (or an em dash if none). */
export function NamespaceLinks({ names }: { names: string[] }): React.ReactElement {
  if (!names.length) return <>—</>;
  return (
    <>
      {names.map((n, i) => (
        <React.Fragment key={n}>
          {i > 0 && ', '}
          <NamespaceLink name={n} />
        </React.Fragment>
      ))}
    </>
  );
}

/**
 * Link to a resource's Headlamp details page: built-in kinds via their resource
 * class, custom resources via the generic `customresource` route.
 */
export function ResourceLink({ item }: { item: AppResource }): React.ReactElement {
  const name = item.metadata?.name ?? '';

  const cls = (K8s.ResourceClasses as any)?.[item.kind];
  if (cls) {
    try {
      const obj = new cls(item);
      if (obj?.getDetailsLink?.()) {
        return <Link kubeObject={obj}>{name}</Link>;
      }
    } catch (e) {
      // fall through
    }
  }

  if (item.group && item.plural) {
    return (
      <Link
        routeName="customresource"
        params={{
          crName: name,
          crd: `${item.plural}.${item.group}`,
          namespace: item.metadata?.namespace || '-',
        }}
      >
        {name}
      </Link>
    );
  }

  return <>{name}</>;
}
