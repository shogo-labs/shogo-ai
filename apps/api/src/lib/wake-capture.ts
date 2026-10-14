// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Lets a chat route learn how the runtime it is about to talk to was woken
 * (cached URL, already running, resumed from a snapshot, cold boot) without
 * threading a return value through every resolver layer. The metal controller
 * reports into whatever capture is active; nothing reported means the URL came
 * from cache or from a non-metal substrate.
 *
 * Dependency-free so the local/desktop bundle can import it statically.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface WakeInfo {
  /** reused | resumed | assigned | assign_timeout | owner_unreachable | failed */
  mode: string
  source?: string
  staleReason?: string
  totalMs?: number
  hostId?: string
  /** Idle-suspend tier the owning host was applying. */
  idleTier?: string
}

const store = new AsyncLocalStorage<{ wake?: WakeInfo }>()

export async function captureWake<T>(fn: () => Promise<T>): Promise<{ value: T; wake?: WakeInfo }> {
  const slot: { wake?: WakeInfo } = {}
  const value = await store.run(slot, fn)
  return { value, wake: slot.wake }
}

export function reportWake(info: WakeInfo): void {
  const slot = store.getStore()
  if (slot) slot.wake = info
}
