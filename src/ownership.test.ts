/*
 * Copyright 2026 Pierre Kisters
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { OwnershipNode, resolveOwnership } from './ownership';

/** node(app, ...ownerUids) — app undefined = unlabelled. */
const node = (app: string | undefined, ...owners: string[]): OwnershipNode => ({
  app,
  ownerRefs: owners.map(uid => ({ uid })),
});

const graph = (entries: Record<string, OwnershipNode>) => new Map(Object.entries(entries));

describe('resolveOwnership', () => {
  it('keeps a labelled node in its own app', () => {
    const r = resolveOwnership(graph({ a: node('web') }));
    expect(r.get('a')).toBe('web');
  });

  it('pulls an unlabelled owner up to its labelled child (CNPG Cluster case)', () => {
    // labelled pod -> unlabelled cluster
    const r = resolveOwnership(graph({ pod: node('pg', 'cluster'), cluster: node(undefined) }));
    expect(r.get('pod')).toBe('pg');
    expect(r.get('cluster')).toBe('pg');
  });

  it('pulls unlabelled children down to a labelled owner (Deployment -> RS -> Pod)', () => {
    const r = resolveOwnership(
      graph({
        pod: node(undefined, 'rs'),
        rs: node(undefined, 'deploy'),
        deploy: node('web'),
      })
    );
    expect(r.get('pod')).toBe('web');
    expect(r.get('rs')).toBe('web');
    expect(r.get('deploy')).toBe('web');
  });

  it('drops an unlabelled node shared by two apps (ambiguous), keeping the labelled ones', () => {
    const r = resolveOwnership(
      graph({
        podA: node('a', 'shared'),
        podB: node('b', 'shared'),
        shared: node(undefined),
      })
    );
    expect(r.get('shared')).toBeNull();
    expect(r.get('podA')).toBe('a');
    expect(r.get('podB')).toBe('b');
  });

  it('drops an unlabelled node with two labelled owners of different apps', () => {
    const r = resolveOwnership(
      graph({ u: node(undefined, 'x', 'y'), x: node('a'), y: node('b') })
    );
    expect(r.get('u')).toBeNull();
    expect(r.get('x')).toBe('a');
    expect(r.get('y')).toBe('b');
  });

  it('drops unlabelled nodes whose component has no labelled member', () => {
    const r = resolveOwnership(graph({ pod: node(undefined, 'rs'), rs: node(undefined) }));
    expect(r.get('pod')).toBeNull();
    expect(r.get('rs')).toBeNull();
  });

  it('is cycle-safe: a reference cycle collapses into one component and resolves', () => {
    // a <-> b cycle, both unlabelled, joined to labelled c
    const r = resolveOwnership(
      graph({ a: node(undefined, 'b', 'c'), b: node(undefined, 'a'), c: node('web') })
    );
    expect(r.get('a')).toBe('web');
    expect(r.get('b')).toBe('web');
    expect(r.get('c')).toBe('web');
  });

  it('is cycle-safe with no labelled node: terminates and drops both', () => {
    const r = resolveOwnership(graph({ a: node(undefined, 'b'), b: node(undefined, 'a') }));
    expect(r.get('a')).toBeNull();
    expect(r.get('b')).toBeNull();
  });

  it('ignores owner refs that point outside the known node set', () => {
    const r = resolveOwnership(graph({ pod: node('web', 'gone') }));
    expect(r.get('pod')).toBe('web');
  });

  it('keeps two separate single-app trees independent', () => {
    const r = resolveOwnership(
      graph({
        podA: node(undefined, 'depA'),
        depA: node('a'),
        podB: node(undefined, 'depB'),
        depB: node('b'),
      })
    );
    expect(r.get('podA')).toBe('a');
    expect(r.get('podB')).toBe('b');
  });

  it('handles a self-referential owner ref without looping', () => {
    const r = resolveOwnership(graph({ a: node('web', 'a') }));
    expect(r.get('a')).toBe('web');
  });
});
