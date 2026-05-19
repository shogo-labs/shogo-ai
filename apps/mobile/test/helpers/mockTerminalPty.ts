// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Shared PTY + xterm mocks for RTL tests that mount `Terminal` or `BottomPanel`.
 *
 * Mocks `pty-factory` (no real WebSocket) and `XtermView` (no xterm.js / Canvas).
 * Import this module for side effects before importing components under test.
 */
import { mock } from 'bun:test'
import * as React from 'react'

export interface FakePtyClient {
  url: string
  state: 'idle' | 'connecting' | 'open' | 'closed' | 'disposed'
  connect: () => void
  send: (text: string | Uint8Array) => void
  resize: (cols: number, rows: number) => void
  signal: (sig: 'INT' | 'TERM' | 'KILL') => void
  dispose: () => void
  onState: (cb: (s: string) => void) => () => void
  onData: (cb: (b: Uint8Array) => void) => () => void
  onExit: (cb: (info: unknown) => void) => () => void
  onError: (cb: (e: Error) => void) => () => void
  onTruncated: (cb: () => void) => () => void
  __fireOpen: () => void
}

export const fakePtyClients: FakePtyClient[] = []
export const ptySendCalls: Array<{ url: string; text: string }> = []
export const ptySignalCalls: Array<{ url: string; sig: string }> = []
export const xtermClearCalls: number[] = []
export const xtermFocusCalls: number[] = []

export function resetTerminalPtyMocks(): void {
  fakePtyClients.length = 0
  ptySendCalls.length = 0
  ptySignalCalls.length = 0
  xtermClearCalls.length = 0
  xtermFocusCalls.length = 0
}

function createFakePtyClient(url: string): FakePtyClient {
  const stateListeners = new Set<(s: string) => void>()
  const errorListeners = new Set<(e: Error) => void>()
  const client: FakePtyClient = {
    url,
    state: 'idle',
    connect() {
      this.state = 'connecting'
      stateListeners.forEach((cb) => cb('connecting'))
    },
    send(text) {
      const s = typeof text === 'string' ? text : new TextDecoder().decode(text)
      ptySendCalls.push({ url, text: s })
    },
    resize() {},
    signal(sig) {
      ptySignalCalls.push({ url, sig })
    },
    dispose() {
      this.state = 'disposed'
      stateListeners.forEach((cb) => cb('disposed'))
    },
    onState(cb) {
      stateListeners.add(cb)
      return () => stateListeners.delete(cb)
    },
    onData() {
      return () => {}
    },
    onExit() {
      return () => {}
    },
    onError(cb) {
      errorListeners.add(cb)
      return () => errorListeners.delete(cb)
    },
    onTruncated() {
      return () => {}
    },
    __fireOpen() {
      this.state = 'open'
      stateListeners.forEach((cb) => cb('open'))
    },
  }
  fakePtyClients.push(client)
  return client
}

const ptyFactoryPath = require.resolve(
  '../../components/project/panels/ide/terminal/pty-factory',
)
const xtermViewPath = require.resolve(
  '../../components/project/panels/ide/terminal/XtermView',
)

mock.module(ptyFactoryPath, () => ({
  createPtyClient: (url: string) => createFakePtyClient(url),
}))

mock.module(xtermViewPath, () => ({
  XtermView: React.forwardRef(function FakeXtermView(
    _props: { client: unknown; hidden?: boolean; autoFocus?: boolean },
    ref: React.Ref<{ clear: () => void; focus: () => void; refit: () => void }>,
  ) {
    React.useImperativeHandle(ref, () => ({
      clear: () => xtermClearCalls.push(Date.now()),
      focus: () => xtermFocusCalls.push(Date.now()),
      refit: () => {},
    }))
    return React.createElement('div', {
      'data-testid': 'xterm-view',
      role: 'group',
      'aria-label': 'Terminal viewport',
    })
  }),
}))
