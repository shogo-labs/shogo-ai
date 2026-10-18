// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The shared background-worker list used by the local/desktop composer.
 *
 * Regression for SHO-36: `local-server.ts` started four of the five polling
 * workers and never started the heartbeat scheduler, so the desktop wrote
 * `agent_configs.nextHeartbeatAt` and nothing ever read it.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const events: string[] = []
const state = {
  runtimeManager: undefined as any,
  heartbeatFailure: null as Error | null,
}

const recorded =
  (name: string) =>
  (...args: any[]) => {
    events.push(`start:${name}`)
    if (name === 'agent-schedule' || name === 'event-delivery') state.runtimeManager = args[0]
    return () => {}
  }
const stopped =
  (name: string) =>
  (..._args: any[]) => {
    events.push(`stop:${name}`)
  }

mock.module('../jobs/run-agent-schedule-dispatch', () => ({
  startAgentScheduleWorker: recorded('agent-schedule'),
  stopAgentScheduleWorker: stopped('agent-schedule'),
}))

mock.module('../jobs/run-event-delivery-dispatch', () => ({
  startEventDeliveryWorker: recorded('event-delivery'),
  stopEventDeliveryWorker: stopped('event-delivery'),
}))

mock.module('../jobs/run-chat-queue-drain', () => ({
  startChatQueueWorker: recorded('chat-queue'),
  stopChatQueueWorker: stopped('chat-queue'),
}))

mock.module('../jobs/run-channel-workers', () => ({
  startChannelWorkers: recorded('channel'),
  stopChannelWorkers: stopped('channel'),
}))

const scheduler = { stop: stopped('heartbeat'), role: 'scheduler-singleton' }

mock.module('../lib/local-heartbeat-scheduler', () => ({
  LocalHeartbeatScheduler: class {},
  getLocalHeartbeatScheduler: () => {
    events.push('get:heartbeat-singleton')
    return scheduler
  },
  startLocalHeartbeatScheduler: async (runtimeProvider: any) => {
    events.push('start:heartbeat')
    if (runtimeProvider !== undefined) state.runtimeManager = runtimeProvider
    if (state.heartbeatFailure) throw state.heartbeatFailure
    return scheduler
  },
}))

const ALL_STARTS = [
  'start:agent-schedule',
  'start:event-delivery',
  'start:chat-queue',
  'start:channel',
  'start:heartbeat',
]

const ALL_STOPS = [
  'stop:agent-schedule',
  'stop:event-delivery',
  'stop:chat-queue',
  'stop:channel',
  'stop:heartbeat',
]

let startLocalBackgroundWorkers: (opts: { runtimeManager: any }) => Promise<void>
let stopLocalBackgroundWorkers: () => void

beforeEach(async () => {
  events.length = 0
  state.runtimeManager = undefined
  state.heartbeatFailure = null
  const mod = await import('../lib/local-background-workers')
  startLocalBackgroundWorkers = mod.startLocalBackgroundWorkers
  stopLocalBackgroundWorkers = mod.stopLocalBackgroundWorkers
})

afterEach(() => {
  events.length = 0
})

describe('startLocalBackgroundWorkers()', () => {
  test('starts all five workers, heartbeat included', async () => {
    await startLocalBackgroundWorkers({ runtimeManager: { id: 'rm' } as any })
    expect(events).toEqual(ALL_STARTS)
  })

  test('hands the runtime manager to the workers that need to wake a project', async () => {
    const runtimeManager = { id: 'rm' } as any
    await startLocalBackgroundWorkers({ runtimeManager })
    expect(state.runtimeManager).toBe(runtimeManager)
  })

  test('a scheduler that fails to start is logged and swallowed', async () => {
    state.heartbeatFailure = new Error('scheduler exploded')
    const warnings: any[][] = []
    const realWarn = console.warn
    console.warn = (...args: any[]) => {
      warnings.push(args)
    }
    try {
      await startLocalBackgroundWorkers({ runtimeManager: {} as any })
    } finally {
      console.warn = realWarn
    }
    expect(events).toContain('start:heartbeat')
    const logged = warnings.find((args) =>
      String(args[0]).startsWith('[LocalHeartbeat] Failed to start (non-fatal):'),
    )
    expect(logged).toBeDefined()
    expect(String(logged![1])).toContain('scheduler exploded')
  })
})

describe('stopLocalBackgroundWorkers()', () => {
  test('stops all five workers, including the heartbeat scheduler singleton', () => {
    stopLocalBackgroundWorkers()
    expect(events.filter((e) => e.startsWith('stop:'))).toEqual(ALL_STOPS)
  })

  test('stops the singleton the admin route reads, not a fresh instance', () => {
    stopLocalBackgroundWorkers()
    expect(events).toContain('get:heartbeat-singleton')
  })
})

describe('local-server.ts', () => {
  test('delegates its worker start/stop to the shared list', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'local-server.ts'), 'utf8')
    expect(source).toContain('startLocalBackgroundWorkers({ runtimeManager })')
    expect(source).toContain('stopLocalBackgroundWorkers()')
    for (const direct of [
      'startAgentScheduleWorker(',
      'startEventDeliveryWorker(',
      'startChatQueueWorker(',
      'startChannelWorkers(',
      'startLocalHeartbeatScheduler(',
    ]) {
      expect(source).not.toContain(direct)
    }
  })
})
