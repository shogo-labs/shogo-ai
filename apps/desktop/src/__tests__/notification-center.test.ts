// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the main-process notification center.
 *
 * The center exists because a notification that is not referenced is
 * garbage-collected, and Electron then drops it from Notification Center and
 * stops firing its handlers. These tests pin that retention, the failure
 * reporting that used to be missing, and the bounds that keep retention from
 * growing without limit.
 *
 * Run: bun test apps/desktop/src/__tests__/notification-center.test.ts
 */

import { describe, expect, test } from 'bun:test'

import { NotificationCenter, type NotificationLike, type NotificationRequest } from '../notification-center'

class FakeNotification implements NotificationLike {
  static instances: FakeNotification[] = []
  readonly request: NotificationRequest
  shown = false
  closed = false
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  constructor(request: NotificationRequest) {
    this.request = request
    FakeNotification.instances.push(this)
  }

  show(): void {
    this.shown = true
  }

  close(): void {
    this.closed = true
    this.emit('close')
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

function makeCenter(options: Partial<ConstructorParameters<typeof NotificationCenter>[0]> = {}) {
  FakeNotification.instances = []
  const logs: string[] = []
  let now = 1_000
  const center = new NotificationCenter({
    create: (request) => new FakeNotification(request),
    now: () => now,
    log: (message) => logs.push(message),
    ...options,
  })
  return {
    center,
    logs,
    advance: (ms: number) => {
      now += ms
    },
    last: () => FakeNotification.instances[FakeNotification.instances.length - 1],
  }
}

const request = { title: 'Reply ready', body: 'The agent finished' }

describe('NotificationCenter — retention', () => {
  test('holds the notification until the OS reports it closed', () => {
    const { center, last } = makeCenter()

    expect(center.show(request)).toEqual({ ok: true })
    expect(last().shown).toBe(true)
    expect(center.getLiveCount()).toBe(1)

    last().emit('close')

    expect(center.getLiveCount()).toBe(0)
  })

  test('still holds the notification after a click so the handler stays reachable', () => {
    const { center, last } = makeCenter()
    const clicks: number[] = []

    center.show(request, { onClick: () => clicks.push(1) })
    last().emit('click')

    expect(clicks).toEqual([1])
    expect(center.getLiveCount()).toBe(1)
  })

  test('caps retention, closing the oldest first', () => {
    const { center, last } = makeCenter({ maxLive: 2 })

    center.show({ title: 'one', body: '' })
    const first = last()
    center.show({ title: 'two', body: '' })
    center.show({ title: 'three', body: '' })

    expect(center.getLiveCount()).toBe(2)
    expect(first.closed).toBe(true)
  })

  test('sweeps notifications the OS never reported closed', () => {
    const { center, last, advance } = makeCenter({ ttlMs: 100 })

    center.show(request)
    const stale = last()
    advance(101)
    center.sweep()

    expect(center.getLiveCount()).toBe(0)
    expect(stale.closed).toBe(true)
  })

  test('closeAll dismisses everything still on screen', () => {
    const { center, last } = makeCenter()

    center.show({ title: 'one', body: '' })
    const first = last()
    center.show({ title: 'two', body: '' })
    center.closeAll()

    expect(center.getLiveCount()).toBe(0)
    expect(first.closed).toBe(true)
  })
})

describe('NotificationCenter — outcomes', () => {
  test('starts unknown and records shown once the OS displays it', () => {
    const { center, last } = makeCenter()

    expect(center.getOutcome().state).toBe('unknown')
    center.show(request)
    last().emit('show')

    expect(center.getOutcome().state).toBe('shown')
  })

  test('records and logs a refusal instead of failing silently', () => {
    const { center, last, logs } = makeCenter()

    center.show(request)
    last().emit('failed', null, 'not authorized')

    expect(center.getOutcome()).toEqual({ state: 'failed', error: 'not authorized', at: 1_000 })
    expect(logs.join('\n')).toContain('not authorized')
    expect(center.getLiveCount()).toBe(0)
  })

  test('reports a failure when the platform has no notifications at all', () => {
    const { center } = makeCenter({ isSupported: () => false })

    expect(center.show(request)).toEqual({ ok: false, reason: 'unsupported' })
    expect(center.getOutcome().state).toBe('failed')
    expect(FakeNotification.instances).toHaveLength(0)
  })

  test('reports a failure when the constructor throws', () => {
    const { center } = makeCenter({
      create: () => {
        throw new Error('bad options')
      },
    })

    expect(center.show(request)).toEqual({ ok: false, reason: 'bad options' })
    expect(center.getOutcome()).toEqual({ state: 'failed', error: 'bad options', at: 1_000 })
  })

  test('reports a failure when show() throws', () => {
    const { center } = makeCenter({
      create: () =>
        ({
          show: () => {
            throw new Error('no display server')
          },
          close: () => {},
          on: () => {},
        }) satisfies NotificationLike,
    })

    expect(center.show(request)).toEqual({ ok: false, reason: 'no display server' })
    expect(center.getLiveCount()).toBe(0)
  })
})
