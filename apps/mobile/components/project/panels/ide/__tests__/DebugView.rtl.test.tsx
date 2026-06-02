// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * RTL coverage for DebugView — verifies the visual contract:
 *
 *   • Step buttons enable/disable based on session state.
 *   • Call stack frames render when paused.
 *   • Breakpoints list renders + the X removes one.
 *   • Console lines render with the right level color class.
 *   • REPL is disabled when not running, calls api.evaluate when submitted.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as React from 'react'
import { DebugView } from '../run/DebugView'
import type { UseDebugSessionApi } from '../run/useDebugSession'

afterEach(cleanup)

function makeApi(overrides: Partial<UseDebugSessionApi['state']> = {}, methodMocks: Partial<UseDebugSessionApi> = {}): UseDebugSessionApi {
  const state: UseDebugSessionApi['state'] = {
    state: 'idle',
    runId: null, sessionId: null, wsUrl: null, script: null, error: null,
    callFrames: [], pausedReason: null, console: [], breakpoints: [],
    ...overrides,
  }
  return {
    state,
    start:    async () => undefined,
    stop:     async () => undefined,
    resume:   async () => undefined,
    pause:    async () => undefined,
    stepOver: async () => undefined,
    stepInto: async () => undefined,
    stepOut:  async () => undefined,
    evaluate: async () => ({ ok: true, text: 'ok' }),
    addBreakpoint:    async () => undefined,
    removeBreakpoint: async () => undefined,
    clearConsole:     () => undefined,
    ...methodMocks,
  }
}

describe('DebugView — header indicator', () => {
  test('idle state shows "idle"', () => {
    render(<DebugView api={makeApi({ state: 'idle' })} />)
    expect(screen.getByText(/idle/i)).toBeDefined()
  })
  test('running state shows "running"', () => {
    render(<DebugView api={makeApi({ state: 'running' })} />)
    expect(screen.getAllByText(/running/i).length).toBeGreaterThan(0)
  })
  test('paused state shows "paused"', () => {
    render(<DebugView api={makeApi({ state: 'paused' })} />)
    expect(screen.getByText(/paused/i)).toBeDefined()
  })
  test('failed state shows error', () => {
    render(<DebugView api={makeApi({ state: 'failed', error: 'cdp refused' })} />)
    expect(screen.getByText(/cdp refused/)).toBeDefined()
  })
})

describe('DebugView — step buttons', () => {
  test('all step buttons disabled when idle', () => {
    render(<DebugView api={makeApi({ state: 'idle' })} />)
    for (const label of ['Continue (F5)', 'Pause', 'Step over (F10)', 'Step into (F11)', 'Step out (⇧F11)']) {
      expect(screen.getByLabelText(label).hasAttribute('disabled')).toBe(true)
    }
  })

  test('paused enables continue + step-over/into/out, disables pause', () => {
    render(<DebugView api={makeApi({ state: 'paused' })} />)
    expect(screen.getByLabelText('Continue (F5)').hasAttribute('disabled')).toBe(false)
    expect(screen.getByLabelText('Step over (F10)').hasAttribute('disabled')).toBe(false)
    expect(screen.getByLabelText('Step into (F11)').hasAttribute('disabled')).toBe(false)
    expect(screen.getByLabelText('Step out (⇧F11)').hasAttribute('disabled')).toBe(false)
    expect(screen.getByLabelText('Pause').hasAttribute('disabled')).toBe(true)
  })

  test('running enables pause + stop, disables steps', () => {
    render(<DebugView api={makeApi({ state: 'running' })} />)
    expect(screen.getByLabelText('Pause').hasAttribute('disabled')).toBe(false)
    expect(screen.getByLabelText('Stop (⇧F5)').hasAttribute('disabled')).toBe(false)
    expect(screen.getByLabelText('Step over (F10)').hasAttribute('disabled')).toBe(true)
  })

  test('continue button calls api.resume', () => {
    let calls = 0
    const api = makeApi({ state: 'paused' }, { resume: async () => { calls += 1 } })
    render(<DebugView api={api} />)
    fireEvent.click(screen.getByLabelText('Continue (F5)'))
    expect(calls).toBe(1)
  })
  test('step over button calls api.stepOver', () => {
    let calls = 0
    const api = makeApi({ state: 'paused' }, { stepOver: async () => { calls += 1 } })
    render(<DebugView api={api} />)
    fireEvent.click(screen.getByLabelText('Step over (F10)'))
    expect(calls).toBe(1)
  })
})

describe('DebugView — call stack', () => {
  test('renders frames when paused', () => {
    const api = makeApi({
      state: 'paused', pausedReason: 'breakpoint',
      callFrames: [
        { callFrameId: 'f1', functionName: 'main',   url: 'file:///work/a.js', lineNumber: 5,  columnNumber: 0 },
        { callFrameId: 'f2', functionName: '(anonymous)', url: 'file:///work/a.js', lineNumber: 14, columnNumber: 2 },
      ],
    })
    render(<DebugView api={api} />)
    expect(screen.getByText('main')).toBeDefined()
    expect(screen.getByText('(anonymous)')).toBeDefined()
    expect(screen.getByText(/Call Stack \(breakpoint\)/i)).toBeDefined()
  })
  test('shows empty hint when no frames', () => {
    render(<DebugView api={makeApi({ state: 'running' })} />)
    expect(screen.getByText(/pause to see frames/i)).toBeDefined()
  })
})

describe('DebugView — breakpoints', () => {
  test('renders breakpoints + remove fires api.removeBreakpoint', () => {
    let removed: string | null = null
    const api = makeApi(
      { state: 'running', breakpoints: [{ id: 'bp1', url: 'file:///a.js', lineNumber: 5 }] },
      { removeBreakpoint: async (id) => { removed = id } },
    )
    render(<DebugView api={api} />)
    expect(screen.getByText(/\/a\.js:6/)).toBeDefined()
    fireEvent.click(screen.getByTitle('Remove breakpoint'))
    expect(removed).toBe('bp1')
  })
  test('empty state offers Add breakpoint when live', () => {
    render(<DebugView api={makeApi({ state: 'running' })} />)
    expect(screen.getByText(/\+ Add breakpoint/i)).toBeDefined()
  })
})

describe('DebugView — console + REPL', () => {
  test('console line shows level pill + text', () => {
    const api = makeApi({
      state: 'running',
      console: [
        { level: 'log',   text: 'hello',                        ts: 1 },
        { level: 'error', text: 'TypeError: x is not a fn',     ts: 2 },
      ],
    })
    render(<DebugView api={api} />)
    expect(screen.getByText('hello')).toBeDefined()
    expect(screen.getByText('TypeError: x is not a fn')).toBeDefined()
    expect(screen.getByText('[log]')).toBeDefined()
    expect(screen.getByText('[error]')).toBeDefined()
  })

  test('REPL is disabled when idle', () => {
    render(<DebugView api={makeApi({ state: 'idle' })} />)
    const input = screen.getByTestId('debug-repl-input') as HTMLInputElement
    expect(input.disabled).toBe(true)
  })

  test('REPL submits via api.evaluate when running', async () => {
    const calls: string[] = []
    const api = makeApi({ state: 'running' }, { evaluate: async (expr) => { calls.push(expr); return { ok: true, text: '42' } } })
    render(<DebugView api={api} />)
    const input = screen.getByTestId('debug-repl-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'x + 1' } })
    fireEvent.submit(input.closest('form')!)
    // Flush microtasks for the async evaluate.
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['x + 1'])
  })
})
