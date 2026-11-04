// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workspace **in view**, derived once for every surface (SHO-130).
 *
 * Since SHO-285 a workspace hosted on a paired desktop is a normal cloud
 * workspace: same id on both sides, same routes. The only thing that differs is
 * where its agent runs, which the badge reads from `hostInstanceId`.
 */

/** A workspace as the UI needs it, whoever hosts it. */
export interface WorkspaceInView {
  id: string
  name: string
  kind: 'personal' | 'team'
  host: 'cloud' | 'machine'
  /** Set for `host: 'machine'`: the paired computer its agent runs on. */
  instanceId?: string
}

/** The cloud workspace a shape-compatible record needs, e.g. `useActiveWorkspace()`. */
export interface CloudWorkspaceLike {
  id?: string | null
  name?: string | null
  kind?: string | null
  hostInstanceId?: string | null
}

function asKind(kind: string | null | undefined): 'personal' | 'team' {
  return kind === 'personal' ? 'personal' : 'team'
}

/**
 * The workspace a surface is showing while the collection is between answers.
 *
 * `useActiveWorkspace()` is null for the whole of every `workspaces.loadAll()`
 * — each in-app navigation refetches the collection — and a screen remounts
 * inside that window on every reopen. A chat that is already on the device must
 * not wait for the list to come back, so a surface that already had the
 * workspace keeps it (`lastInView`), and one that has never resolved it in this
 * JS session falls back to the person's persisted selection with the `kind`
 * cached for it — the same pair `useWorkspaceExperience` uses so a returning
 * user does not flash the team shell (SHO-309).
 *
 * Answer null when the selection has no cached kind: an id this device has
 * never resolved is not a workspace the surface can show yet.
 */
export function workspaceInViewWhileLoading(
  inView: WorkspaceInView | null,
  lastInView: WorkspaceInView | null,
  selectedId: string | null | undefined,
  cachedKind: 'personal' | 'team' | null,
): WorkspaceInView | null {
  if (inView) return inView
  if (lastInView && lastInView.id === selectedId) return lastInView
  if (!selectedId || !cachedKind) return null
  return { id: selectedId, name: selectedId, kind: cachedKind, host: 'cloud' }
}

/** The workspace the user is looking at. */
export function workspaceInView(cloud: CloudWorkspaceLike | null | undefined): WorkspaceInView | null {
  if (!cloud?.id) return null
  return {
    id: cloud.id,
    name: cloud.name ?? cloud.id,
    kind: asKind(cloud.kind),
    host: cloud.hostInstanceId ? 'machine' : 'cloud',
    ...(cloud.hostInstanceId ? { instanceId: cloud.hostInstanceId } : {}),
  }
}
