// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hook Event Emitter
 *
 * Manages hook registration and event emission with error isolation.
 */

import type { Hook, HookEvent, HookHandler } from './types'

export class HookEmitter {
  private hooks: Hook[] = []

  register(hooks: Hook[]): void {
    this.hooks = hooks
    for (const hook of hooks) {
      console.log(`[Hooks] Registered: ${hook.name} -> ${hook.events.join(', ')}`)
    }
  }

  getRegisteredHooks(): Hook[] {
    return [...this.hooks]
  }

  /** Hooks subscribed to `event`: `type:action`, `type`, `*`, or a `type:prefix.*` wildcard. */
  matching(event: Pick<HookEvent, 'type' | 'action'>): Hook[] {
    const eventKey = `${event.type}:${event.action}`
    return this.hooks.filter((h) =>
      h.events.some((pattern) =>
        pattern === eventKey ||
        pattern === event.type ||
        pattern === '*' ||
        (pattern.endsWith('.*') && eventKey.startsWith(pattern.slice(0, -1)))))
  }

  /**
   * Emit an event to all matching hooks. Handlers run concurrently.
   * One handler failure does not block others.
   */
  async emit(event: HookEvent): Promise<{ matched: number; failed: number; errors: string[] }> {
    const eventKey = `${event.type}:${event.action}`
    const matching = this.matching(event)

    if (matching.length === 0) return { matched: 0, failed: 0, errors: [] }

    const results = await Promise.allSettled(
      matching.map(async (hook) => {
        try {
          await hook.handler(event)
        } catch (err: any) {
          console.error(`[Hooks] Error in ${hook.name} for ${eventKey}:`, err.message)
          throw err
        }
      })
    )

    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failures.length > 0) {
      console.warn(
        `[Hooks] ${failures.length}/${matching.length} handlers failed for ${eventKey}`
      )
    }
    return {
      matched: matching.length,
      failed: failures.length,
      errors: failures.map((f) => String(f.reason?.message ?? f.reason)),
    }
  }

  /** Create a HookEvent with defaults filled in */
  static createEvent(
    type: HookEvent['type'],
    action: string,
    sessionKey: string,
    context: Record<string, any> = {}
  ): HookEvent {
    return {
      type,
      action,
      sessionKey,
      timestamp: new Date(),
      messages: [],
      context,
    }
  }
}
