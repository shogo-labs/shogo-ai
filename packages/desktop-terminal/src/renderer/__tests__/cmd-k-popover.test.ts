// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import {
  CmdKController,
  type CmdKSnapshot,
  type LlmClient,
  type LlmStreamHandle,
  type LlmStreamRequest,
} from '../cmd-k-popover'

// ─── manual clock ─────────────────────────────────────────────────

interface Clock {
  schedule(cb: () => void, delayMs: number): number
  cancel(handle: number): void
  tick(): void
  pending(): number
}

function makeClock(): Clock {
  const queue: { id: number; cb: () => void }[] = []
  let nextId = 1
  return {
    schedule(cb): number { const id = nextId++; queue.push({ id, cb }); return id },
    cancel(h): void {
      const idx = queue.findIndex((e) => e.id === h)
      if (idx >= 0) queue.splice(idx, 1)
    },
    tick(): void {
      const due = queue.splice(0)
      for (const { cb } of due) cb()
    },
    pending(): number { return queue.length },
  }
}

// ─── fake LLM ─────────────────────────────────────────────────────

interface FakeLlmHandle extends LlmStreamHandle {
  cancelled: boolean
  /** Drive the stream from the test. */
  emit(delta: string): void
  finish(final?: string): void
  fail(message: string): void
}

interface FakeLlm {
  client: LlmClient
  inflight(): FakeLlmHandle | null
  /** Stream requests in arrival order. */
  requests(): LlmStreamRequest[]
}

function makeLlm(): FakeLlm {
  let current: FakeLlmHandle | null = null
  const reqs: LlmStreamRequest[] = []
  return {
    client: {
      async streamCommand(req: LlmStreamRequest): Promise<LlmStreamHandle> {
        reqs.push(req)
        // Bind callbacks per-handle so emit() on an older (cancelled)
        // handle still routes to that handle's original callbacks —
        // lets us simulate "stale stream" races realistically.
        const handle: FakeLlmHandle = {
          cancelled: false,
          cancel() { this.cancelled = true; if (current === handle) current = null },
          emit(delta) { req.onDelta(delta) },
          finish(final) { req.onDone(final ?? '') },
          fail(msg) { req.onError(new Error(msg)) },
        }
        current = handle
        return handle
      },
    },
    inflight() { return current },
    requests() { return reqs },
  }
}

// ─── helpers ──────────────────────────────────────────────────────

function makeController(opts: { clock?: Clock; llm?: FakeLlm; submits?: string[] } = {}): {
  controller: CmdKController
  clock: Clock
  llm: FakeLlm
  submits: string[]
  snapshots: CmdKSnapshot[]
} {
  const clock = opts.clock ?? makeClock()
  const llm = opts.llm ?? makeLlm()
  const submits = opts.submits ?? []
  const controller = new CmdKController({
    llm: llm.client,
    contextProvider: () => ({ cwd: '/tmp', shell: '/bin/zsh', os: 'mac', recentCommands: [] }),
    onSubmit: (cmd) => submits.push(cmd),
    debounceMs: 5,
    schedule: clock.schedule,
    cancel: clock.cancel,
  })
  const snapshots: CmdKSnapshot[] = []
  controller.on((s) => snapshots.push(s))
  return { controller, clock, llm, submits, snapshots }
}

// Drain microtasks so the awaited streamCommand resolves before we
// poke the handle (cancel/etc).
async function settle(): Promise<void> { await Promise.resolve(); await Promise.resolve() }

// ─── lifecycle ────────────────────────────────────────────────────

describe('CmdKController — open/close lifecycle', () => {
  it('starts in idle, transitions to composing on open()', () => {
    const { controller } = makeController()
    expect(controller.state).toBe('idle')
    controller.open()
    expect(controller.state).toBe('composing')
    expect(controller.snapshot().prompt).toBe('')
  })

  it('close() returns to idle and clears prompt + suggestion', async () => {
    const { controller, clock, llm } = makeController()
    controller.open()
    controller.setPrompt('rename .jpg to .jpeg')
    clock.tick()
    await settle()
    llm.inflight()!.emit('mv ')
    expect(controller.state).toBe('streaming')
    controller.close()
    expect(controller.state).toBe('idle')
    expect(controller.snapshot().prompt).toBe('')
    expect(controller.snapshot().suggestion).toBe('')
  })

  it('setPrompt is a no-op when idle', () => {
    const { controller, clock } = makeController()
    controller.setPrompt('whatever')
    clock.tick()
    expect(controller.state).toBe('idle')
  })
})

// ─── debounce + streaming ─────────────────────────────────────────

describe('CmdKController — debounced streaming', () => {
  it('schedules a stream after debounce window expires', async () => {
    const { controller, clock, llm } = makeController()
    controller.open()
    controller.setPrompt('list files')
    expect(controller.state).toBe('composing') // not streaming yet
    expect(llm.requests()).toHaveLength(0)
    clock.tick()
    await settle()
    expect(controller.state).toBe('streaming')
    expect(llm.requests()).toHaveLength(1)
    expect(llm.requests()[0]!.prompt).toBe('list files')
  })

  it('subsequent typing during stream cancels and re-issues', async () => {
    const { controller, clock, llm } = makeController()
    controller.open()
    controller.setPrompt('list files')
    clock.tick()
    await settle()
    const first = llm.inflight()!
    expect(first.cancelled).toBe(false)
    controller.setPrompt('list all files')
    clock.tick()
    await settle()
    expect(first.cancelled).toBe(true)
    expect(llm.requests()).toHaveLength(2)
    expect(llm.requests()[1]!.prompt).toBe('list all files')
  })

  it('appends streamed deltas into snapshot.suggestion', async () => {
    const { controller, clock, llm } = makeController()
    controller.open()
    controller.setPrompt('list files')
    clock.tick()
    await settle()
    const h = llm.inflight()!
    h.emit('ls ')
    h.emit('-la')
    expect(controller.snapshot().suggestion).toBe('ls -la')
  })

  it('transitions to ready on onDone with the final suggestion trimmed', async () => {
    const { controller, clock, llm } = makeController()
    controller.open()
    controller.setPrompt('list files')
    clock.tick()
    await settle()
    llm.inflight()!.emit('ls -la')
    llm.inflight()!.finish('  ls -la  ')
    expect(controller.state).toBe('ready')
    expect(controller.snapshot().suggestion).toBe('ls -la')
  })

  it('transitions to error on onError with the message', async () => {
    const { controller, clock, llm } = makeController()
    controller.open()
    controller.setPrompt('x')
    clock.tick()
    await settle()
    llm.inflight()!.fail('rate limit')
    expect(controller.state).toBe('error')
    expect(controller.snapshot().errorMessage).toBe('rate limit')
  })

  it('clears suggestion + cancels in-flight when prompt is emptied', async () => {
    const { controller, clock, llm } = makeController()
    controller.open()
    controller.setPrompt('x')
    clock.tick()
    await settle()
    const h = llm.inflight()!
    h.emit('cmd')
    controller.setPrompt('')
    expect(controller.state).toBe('composing')
    expect(controller.snapshot().suggestion).toBe('')
    expect(h.cancelled).toBe(true)
  })

  it('ignores late deltas from a cancelled stream', async () => {
    const { controller, clock, llm } = makeController()
    controller.open()
    controller.setPrompt('a')
    clock.tick()
    await settle()
    const first = llm.inflight()!
    controller.setPrompt('b')
    clock.tick()
    await settle()
    // first stream is cancelled but a stale handler might still fire
    first.emit('STALE')
    expect(controller.snapshot().suggestion).not.toContain('STALE')
  })
})

// ─── submission ──────────────────────────────────────────────────

describe('CmdKController — submit', () => {
  it('returns false when not in ready state', () => {
    const { controller } = makeController()
    expect(controller.submit()).toBe(false)
    controller.open()
    expect(controller.submit()).toBe(false)
  })

  it('fires onSubmit with the trimmed suggestion and returns to idle', async () => {
    const { controller, clock, llm, submits } = makeController()
    controller.open()
    controller.setPrompt('list files')
    clock.tick()
    await settle()
    llm.inflight()!.finish('ls -la')
    expect(controller.submit()).toBe(true)
    expect(submits).toEqual(['ls -la'])
    expect(controller.state).toBe('idle')
  })

  it('refuses to submit when suggestion is empty after trim', async () => {
    const { controller, clock, llm } = makeController()
    controller.open()
    controller.setPrompt('x')
    clock.tick()
    await settle()
    llm.inflight()!.finish('   ')
    expect(controller.submit()).toBe(false)
  })
})

// ─── context provider ───────────────────────────────────────────

describe('CmdKController — context provider', () => {
  it('queries the context provider for every stream', async () => {
    let calls = 0
    const llm = makeLlm()
    const clock = makeClock()
    const controller = new CmdKController({
      llm: llm.client,
      contextProvider() {
        calls++
        return { cwd: `/dir/${calls}`, shell: '/bin/zsh', os: 'mac', recentCommands: [`cmd-${calls}`] }
      },
      onSubmit: () => undefined,
      debounceMs: 1,
      schedule: clock.schedule, cancel: clock.cancel,
    })
    controller.open()
    controller.setPrompt('a')
    clock.tick(); await settle()
    controller.setPrompt('b')
    clock.tick(); await settle()
    expect(llm.requests()[0]!.context.cwd).toBe('/dir/1')
    expect(llm.requests()[1]!.context.cwd).toBe('/dir/2')
    expect(calls).toBe(2)
  })
})

// ─── dispose ─────────────────────────────────────────────────────

describe('CmdKController — dispose', () => {
  it('cancels in-flight stream and clears listeners', async () => {
    const { controller, clock, llm, snapshots } = makeController()
    controller.open()
    controller.setPrompt('x')
    clock.tick()
    await settle()
    const h = llm.inflight()!
    snapshots.length = 0
    controller.dispose()
    expect(h.cancelled).toBe(true)
    // Further state pokes don't fire listeners post-dispose.
    controller.open()
    expect(snapshots).toEqual([])
  })
})
