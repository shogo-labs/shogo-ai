// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  createDictationController,
  parseHelperLine,
  type DictationEvent,
} from '../dictation-controller'

function harness(holdDelayMs = 150) {
  const events: DictationEvent[] = []
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  const controller = createDictationController({
    emit: (e) => events.push(e),
    holdDelayMs,
    setTimer: (fn, ms) => {
      const id = next++
      timers.set(id, { fn, ms })
      return id
    },
    clearTimer: (h) => {
      timers.delete(h as number)
    },
  })
  const fire = () => {
    for (const [id, t] of [...timers]) {
      timers.delete(id)
      t.fn()
    }
  }
  return { controller, events, timers, fire }
}

describe('push to talk', () => {
  test('starts only after the hold threshold, stops on release', () => {
    const { controller, events, fire, timers } = harness(200)
    controller.pttDown()
    expect(events).toEqual([])
    expect([...timers.values()][0].ms).toBe(200)
    fire()
    expect(events).toEqual([{ type: 'start', mode: 'push' }])
    controller.pttUp()
    expect(events.at(-1)).toEqual({ type: 'stop', mode: 'push' })
    expect(controller.phase()).toBe('idle')
  })

  test('a quick tap never starts a recording', () => {
    const { controller, events, timers } = harness()
    controller.pttDown()
    controller.pttUp()
    expect(timers.size).toBe(0)
    expect(events).toEqual([])
    expect(controller.phase()).toBe('idle')
  })

  test('another key during the hold cancels before it starts', () => {
    const { controller, events, timers } = harness()
    controller.pttDown()
    controller.combo()
    expect(timers.size).toBe(0)
    expect(events).toEqual([])
  })

  test('another key after it started cancels the recording', () => {
    const { controller, events, fire } = harness()
    controller.pttDown()
    fire()
    controller.combo()
    expect(events).toEqual([
      { type: 'start', mode: 'push' },
      { type: 'cancel', mode: 'push' },
    ])
    // The trailing key-up must not emit a stray stop.
    controller.pttUp()
    expect(events).toHaveLength(2)
  })

  test('key repeat while held does not restart', () => {
    const { controller, events, fire } = harness()
    controller.pttDown()
    controller.pttDown()
    fire()
    controller.pttDown()
    expect(events).toEqual([{ type: 'start', mode: 'push' }])
  })
})

describe('hands-free toggle', () => {
  test('alternates start and stop', () => {
    const { controller, events } = harness()
    controller.toggle()
    controller.toggle()
    expect(events).toEqual([
      { type: 'start', mode: 'toggle' },
      { type: 'stop', mode: 'toggle' },
    ])
  })

  test('push-to-talk press ends a hands-free session', () => {
    const { controller, events } = harness()
    controller.toggle()
    controller.pttDown()
    expect(events.at(-1)).toEqual({ type: 'stop', mode: 'toggle' })
    expect(controller.phase()).toBe('idle')
  })

  test('toggle is ignored mid push-to-talk', () => {
    const { controller, events, fire } = harness()
    controller.pttDown()
    fire()
    controller.toggle()
    expect(events).toEqual([{ type: 'start', mode: 'push' }])
  })
})

describe('reset', () => {
  test('cancels an active recording and clears a pending hold', () => {
    const a = harness()
    a.controller.toggle()
    a.controller.reset()
    expect(a.events.at(-1)).toEqual({ type: 'cancel', mode: 'toggle' })

    const b = harness()
    b.controller.pttDown()
    b.controller.reset()
    expect(b.timers.size).toBe(0)
    expect(b.events).toEqual([])
    expect(b.controller.phase()).toBe('idle')
  })
})

describe('parseHelperLine', () => {
  test('parses known events', () => {
    expect(parseHelperLine('{"event":"ready"}')).toEqual({ event: 'ready' })
    expect(parseHelperLine('{"event":"ptt","down":true}')).toEqual({ event: 'ptt', down: true })
    expect(parseHelperLine('{"event":"combo"}')).toEqual({ event: 'combo' })
    expect(parseHelperLine('{"event":"listening","chord":"Fn"}')).toEqual({ event: 'listening', chord: 'Fn' })
    expect(parseHelperLine('{"event":"waiting","reason":"accessibility"}')).toEqual({
      event: 'waiting',
      reason: 'accessibility',
    })
    expect(parseHelperLine('{"event":"error","message":"boom"}')).toEqual({ event: 'error', message: 'boom' })
  })

  test('rejects malformed or unknown input', () => {
    expect(parseHelperLine('')).toBeNull()
    expect(parseHelperLine('not json')).toBeNull()
    expect(parseHelperLine('42')).toBeNull()
    expect(parseHelperLine('{"event":"mystery"}')).toBeNull()
    expect(parseHelperLine('{"event":"ptt"}')).toBeNull()
  })
})
