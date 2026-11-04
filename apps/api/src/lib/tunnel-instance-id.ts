// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * This process's cloud `Instance.id`, as a leaf module (SHO-285 Update 2).
 *
 * The id belongs to the tunnel (`instance-tunnel.ts`): it arrives with the
 * tunnel's first heartbeat and is null until the cloud answers one. Reading it
 * should not cost a dependency on the tunnel, though — that module pulls in the
 * runtime manager, and through it the whole agent-runtime graph, so every
 * service that only asks "which device am I" would drag that in with it.
 *
 * So the tunnel registers how to read the id at load time, and everyone else
 * asks this module.
 */

type InstanceIdSource = () => string | null

let source: InstanceIdSource | null = null

/** Called once by the tunnel; the reader is queried per call, never cached. */
export function registerInstanceIdSource(next: InstanceIdSource): void {
  source = next
}

/** The cloud instance id, or null on the cloud, before pairing, or pre-heartbeat. */
export function activeInstanceId(): string | null {
  try {
    return source?.() ?? null
  } catch {
    return null
  }
}
