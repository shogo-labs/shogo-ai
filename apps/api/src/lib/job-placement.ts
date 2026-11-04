// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Where a background job runs (SHO-285 Update 2, Russell's answer on the card):
 * **where it was requested, with the cloud as the default.**
 *
 * A job created from the cloud, the phone, or a cloud-runtime turn carries
 * `runOnInstanceId = null` and runs in the cloud. A job created from a desktop
 * window, or by a turn running on that desktop, carries that device's
 * `Instance.id` and runs there. Exactly one scheduler fires each job, which is
 * the whole point: the cloud and every desktop poll the same rows, so the
 * filters below have to be exact complements.
 *
 * The Personal workspace is the case that makes this necessary. It is one
 * workspace on every surface, so its schedules and heartbeats are visible to
 * every device — and an unpinned job of the Personal belongs to the cloud, not
 * to whichever desktop happens to be awake.
 */

import { hostedWorkspacesResolveHere } from './cloud-topology'
import { getInstanceId } from './instance-tunnel'

/** True in a desktop process (local mode), false in the cloud API. */
export function isDesktopRuntime(): boolean {
  return !hostedWorkspacesResolveHere()
}

/**
 * This desktop's cloud `Instance.id`, or null before the tunnel has registered
 * (a fresh boot, or an unpaired desktop).
 */
export function desktopInstanceId(): string | null {
  if (!isDesktopRuntime()) return null
  try {
    return getInstanceId()
  } catch {
    return null
  }
}

/**
 * The `runOnInstanceId` a job created right now should carry: this desktop's
 * instance id when the request is being served by a desktop (a desktop window,
 * or a turn running there), null in the cloud — which is the default.
 */
export function jobPlacement(): string | null {
  return isDesktopRuntime() ? desktopInstanceId() : null
}

/**
 * Prisma `where` for the `AgentSchedule` rows this process must fire.
 *
 * Cloud: unpinned jobs of workspaces the cloud runs (no host).
 * Desktop: jobs pinned to this device, plus unpinned jobs of workspaces that
 * are not the account's Personal — a local-only workspace on an unpaired
 * desktop still runs its own schedules.
 */
export function schedulePlacementWhere(): Record<string, unknown> {
  if (!isDesktopRuntime()) {
    return { runOnInstanceId: null, workspace: { hostInstanceId: null } }
  }
  const instanceId = desktopInstanceId()
  const localOnly = { runOnInstanceId: null, workspace: { personalOwnerId: null } }
  return instanceId ? { OR: [{ runOnInstanceId: instanceId }, localOnly] } : localOnly
}

/**
 * Prisma `where` for the `AgentConfig` (heartbeat) rows this process must fire.
 * Same rule as `schedulePlacementWhere`, reached through the project.
 */
export function heartbeatPlacementWhere(): Record<string, unknown> {
  if (!isDesktopRuntime()) {
    return { runOnInstanceId: null, project: { workspace: { hostInstanceId: null } } }
  }
  const instanceId = desktopInstanceId()
  const localOnly = { runOnInstanceId: null, project: { workspace: { personalOwnerId: null } } }
  return instanceId ? { OR: [{ runOnInstanceId: instanceId }, localOnly] } : localOnly
}

/**
 * The cloud heartbeat query is raw SQL, so it needs the same rule as a
 * fragment. `ac` is the `agent_configs` alias, `w` the joined workspace.
 */
export function heartbeatPlacementSql(): string {
  return 'AND ac."runOnInstanceId" IS NULL AND w."hostInstanceId" IS NULL'
}
