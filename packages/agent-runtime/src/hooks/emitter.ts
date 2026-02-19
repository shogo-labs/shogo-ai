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

  /**
   * Emit an event to all matching hooks. Handlers run concurrently.
   * One handler failure does not block others.
   */
  async emit(event: HookEvent): Promise<void> {
    const eventKey = `${event.type}:${event.action}`
    const generalKey = event.type

    const matching = this.hooks.filter(
      (h) =>
        h.events.includes(eventKey) ||
        h.events.includes(generalKey) ||
        h.events.includes('*')
    )

    if (matching.length === 0) return

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

    const failures = results.filter((r) => r.status === 'rejected')
    if (failures.length > 0) {
      console.warn(
        `[Hooks] ${failures.length}/${matching.length} handlers failed for ${eventKey}`
      )
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
