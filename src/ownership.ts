/*
 * Copyright 2026 Pierre Kisters
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure ownership-graph resolution: given the objects and their ownerReferences,
 * decide which app each belongs to. No I/O and no framework deps, so it's
 * unit-testable in isolation.
 */

export interface OwnershipNode {
  /** ownerReferences of this object (only the uid is used here). */
  ownerRefs: { uid?: string }[];
  /** the app.kubernetes.io/instance value, if this object carries one. */
  app?: string;
}

/**
 * Resolve each node to its app:
 *  - a labelled node   -> its own app.
 *  - an unlabelled node -> the single app of its ownership component, or `null`
 *    if that component holds zero or more than one app (ambiguous -> drop).
 *
 * Edges are ownerReferences (child -> owner) but treated as undirected for
 * connectivity, so this covers BOTH an unlabelled parent above a labelled child
 * (a CNPG Cluster over labelled pods) and unlabelled children below a labelled
 * parent (a Deployment's ReplicaSet/pods).
 *
 * Implemented with union-find over the edges: a reference cycle simply collapses
 * into one component — there's no recursion and the `parent` map is always a
 * forest, so it runs in O(V·α(V)) and cannot loop, however tangled the input.
 */
export function resolveOwnership(nodes: Map<string, OwnershipNode>): Map<string, string | null> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // path compression
    let cur = x;
    while (parent.get(cur) !== root) {
      const p = parent.get(cur)!;
      parent.set(cur, root);
      cur = p;
    }
    return root;
  };

  for (const uid of nodes.keys()) parent.set(uid, uid);
  for (const [uid, n] of nodes) {
    for (const ref of n.ownerRefs) {
      if (ref?.uid && nodes.has(ref.uid)) {
        const ra = find(uid);
        const rb = find(ref.uid);
        if (ra !== rb) parent.set(ra, rb);
      }
    }
  }

  // Distinct apps present in each component (keyed by component root).
  const compApps = new Map<string, Set<string>>();
  for (const [uid, n] of nodes) {
    if (!n.app) continue;
    const root = find(uid);
    let s = compApps.get(root);
    if (!s) {
      s = new Set();
      compApps.set(root, s);
    }
    s.add(n.app);
  }

  const out = new Map<string, string | null>();
  for (const [uid, n] of nodes) {
    if (n.app) {
      out.set(uid, n.app); // a labelled node always resolves to its own app
      continue;
    }
    const apps = compApps.get(find(uid));
    out.set(uid, apps && apps.size === 1 ? [...apps][0] : null);
  }
  return out;
}
