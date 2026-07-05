// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Concurrency primitives for the node-agent under load:
 *
 *  - Singleflight collapses concurrent calls for the SAME key into one
 *    in-flight operation (the classic thundering-herd guard). A burst of
 *    /assign for one project — common when a browser opens several tabs, or
 *    the control plane retries — must not spawn several cold boots or racing
 *    resumes; they all await the first.
 *
 *  - Semaphore caps concurrent HEAVY operations host-wide (snapshot create,
 *    durable pull/push). The load tests showed the Firecracker snapshot path
 *    throws ~3-17% 500s when many run at once against the same NVMe; a small
 *    limit (2-3) keeps throughput without the stampede.
 *
 * Dependency-free (matches the agent's single-`bun run` deploy model).
 */

export class Singleflight<T = unknown> {
  private inflight = new Map<string, Promise<T>>()

  /** True if an op for `key` is currently running (GC uses this to skip). */
  has(key: string): boolean {
    return this.inflight.has(key)
  }

  get size(): number {
    return this.inflight.size
  }

  /** Run `fn` for `key`, or join the already-running call for the same key. */
  async run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key)
    if (existing) return existing
    const p = (async () => {
      try {
        return await fn()
      } finally {
        this.inflight.delete(key)
      }
    })()
    this.inflight.set(key, p)
    return p
  }
}

export class Semaphore {
  private permits: number
  private queue: Array<() => void> = []

  constructor(max: number) {
    this.permits = Math.max(1, max)
  }

  get available(): number {
    return this.permits
  }
  get waiting(): number {
    return this.queue.length
  }

  private async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.permits--
  }

  private release(): void {
    this.permits++
    const next = this.queue.shift()
    if (next) next()
  }

  /** Run `fn` holding one permit; releases even if `fn` throws. */
  async run<R>(fn: () => Promise<R>): Promise<R> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}
