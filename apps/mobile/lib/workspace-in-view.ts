// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workspace **in view**, derived once for every surface (SHO-130).
 *
 * A paired computer's own workspace is not an overlay on top of the cloud
 * workspace that happens to be selected: while it is open it *is* the workspace
 * on screen. Its id, name and kind decide the route, the chrome, the chat
 * session, the collections and the channels; the cloud workspace keeps only
 * auth, billing, membership and the machine list (see
 * `MACHINE_WORKSPACE_CLOUD_ONLY` in `remote-http-interceptor`).
 *
 * `useActiveWorkspace()` keeps answering the *cloud* workspace — identity,
 * billing and membership are the cloud account's — so every surface that shows
 * or scopes workspace data reads this instead.
 */

import type { ActiveInstance } from '../contexts/active-instance'

/** A workspace as the UI needs it, whoever hosts it. */
export interface WorkspaceInView {
  /** The hosting database's own id: a cloud id, or the machine's local id. */
  id: string
  name: string
  kind: 'personal' | 'team'
  host: 'cloud' | 'machine'
  /** Set for `host: 'machine'`: the paired computer serving this workspace. */
  instanceId?: string
}

/** The cloud workspace a shape-compatible record needs, e.g. `useActiveWorkspace()`. */
export interface CloudWorkspaceLike {
  id?: string | null
  name?: string | null
  kind?: string | null
}

function asKind(kind: string | null | undefined): 'personal' | 'team' {
  return kind === 'personal' ? 'personal' : 'team'
}

/**
 * A paired computer's own workspace, while one is open.
 *
 * A machine record persisted by an older client carries no kind; the machine
 * is the workspace's host either way, and `team` is the same fail-safe default
 * `workspaceExperience()` uses for an unknown workspace.
 */
export function machineWorkspaceInView(
  instance: ActiveInstance | null | undefined,
): WorkspaceInView | null {
  if (instance?.source !== 'machine' || !instance.localWorkspaceId) return null
  return {
    id: instance.localWorkspaceId,
    name: instance.localWorkspaceName ?? instance.name ?? instance.hostname,
    kind: asKind(instance.localWorkspaceKind),
    host: 'machine',
    instanceId: instance.instanceId,
  }
}

/**
 * The workspace the user is looking at: the machine's while one of its own
 * workspaces is open, the cloud workspace otherwise.
 */
export function workspaceInView(
  cloud: CloudWorkspaceLike | null | undefined,
  instance: ActiveInstance | null | undefined,
): WorkspaceInView | null {
  const machine = machineWorkspaceInView(instance)
  if (machine) return machine
  if (!cloud?.id) return null
  return {
    id: cloud.id,
    name: cloud.name ?? cloud.id,
    kind: asKind(cloud.kind),
    host: 'cloud',
  }
}
