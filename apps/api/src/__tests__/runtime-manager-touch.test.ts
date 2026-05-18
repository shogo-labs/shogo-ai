// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression coverage for the long-lived-stream / idle-eviction bug.
 *
 * Symptom: a `/agent/canvas/stream` SSE that lasted longer than
 * `WorkerRuntimeManager`'s 15-minute idle window got SIGTERM'd
 * mid-stream, producing the cascade
 *
 *     [WorkerRuntimeManager] idle-evicting <pid> after 900s
 *     error: ECONNRESET
 *     [ProjectChat] EOF without turn-complete ... server-side resume from buffer
 *     [AgentProxy] GET /agent/canvas/stream failed after 24 attempts
 *
 * spamming the API log every few seconds while the front-end's auto-
 * reconnecting EventSource hammered a dead localhost port.
 *
 * Root cause: the embedded WorkerRuntimeManager only resets its idle
 * timer on `touch()`, and `touch()` was only called during fresh proxy
 * resolution (`resolveLocalUrl()`). A long-lived stream that opened
 * once and then quietly streamed bytes for 30 minutes never re-touched
 * the timer.
 *
 * Fix:
 *   1. `IRuntimeManager.touch(projectId)` is part of the public
 *      contract, with explicit "must not throw on unknown projectId"
 *      semantics — the agent-proxy can call it on every chunk
 *      without first checking whether the request was routed to a
 *      local runtime vs. a cloud pod.
 *   2. `RuntimeManager.touch()` delegates to the embedded
 *      `WorkerRuntimeManager.touch()`, which is the slot that owns the
 *      `setTimeout` we want to re-arm.
 *
 * These tests pin both invariants so a future refactor can't silently
 * regress the streaming-keepalive contract.
 */

import { describe, expect, test } from 'bun:test'
import { WorkerRuntimeManager } from '@shogo-ai/worker/runtime-manager'
import { RuntimeManager } from '../lib/runtime'

describe('RuntimeManager.touch', () => {
  test('is a no-op for unknown project IDs (does not throw)', () => {
    const rm = new RuntimeManager()
    // Cloud-pod / k8s mode: nothing has been spawned locally for this
    // project ID. The agent-proxy still calls touch() on every stream
    // heartbeat — that must not throw.
    expect(() => rm.touch('proj-that-was-never-spawned')).not.toThrow()
  })

  test('delegates to the embedded WorkerRuntimeManager', () => {
    const rm = new RuntimeManager()
    const calls: string[] = []
    const original = WorkerRuntimeManager.prototype.touch
    WorkerRuntimeManager.prototype.touch = function (this: unknown, projectId: string) {
      calls.push(projectId)
      // Don't actually call original — it would noop on an empty slot
      // map, which is fine, but spying via in-place override is the
      // cheapest way to make the assertion observable without exposing
      // `agentManager` for testing.
    }

    try {
      rm.touch('proj-1')
      rm.touch('proj-2')
      expect(calls).toEqual(['proj-1', 'proj-2'])
    } finally {
      WorkerRuntimeManager.prototype.touch = original
    }
  })

  test('swallows downstream errors instead of propagating them up the proxy', () => {
    const rm = new RuntimeManager()
    const original = WorkerRuntimeManager.prototype.touch
    WorkerRuntimeManager.prototype.touch = function () {
      // Simulate a future refactor where touch() can throw — e.g. if
      // the slot map gets re-keyed and a stale projectId hits a
      // type assertion. The proxy must still keep streaming.
      throw new Error('boom')
    }

    try {
      // Silence the warn so test output stays clean; we still want to
      // exercise the catch branch.
      const original_warn = console.warn
      console.warn = () => {}
      try {
        expect(() => rm.touch('proj-1')).not.toThrow()
      } finally {
        console.warn = original_warn
      }
    } finally {
      WorkerRuntimeManager.prototype.touch = original
    }
  })
})
