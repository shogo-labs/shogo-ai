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
