// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The recording transition reaches its listeners from the capture itself
 * (SHO-555, QA round 2).
 *
 * `tray-recording.test.ts` pins the tray *reacting* to a recording change, but
 * it fires the listeners itself — so it passes even if `recording.ts` stops
 * dispatching, and the menu-bar item would silently go back to showing "Start
 * Recording" during a capture. This drives the real `handleRecordingEvent`
 * through the real `RecordingManager` `onEvent` callback, so the dispatch on
 * session-started / -stopped / -aborted is what is under test.
 */
import { describe, expect, mock, test } from 'bun:test'

type ManagerOptions = { onEvent: (evt: unknown) => void }
let managerOptions: ManagerOptions | null = null

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/tmp',
    getPath: () => '/tmp/shogo-qa-recording-dispatch',
    quit: () => {},
    focus: () => {},
    getVersion: () => '0.0.0',
    on: () => {},
  },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {
    static isSupported(): boolean {
      return false
    }
    show(): void {}
    on(): void {}
  },
  shell: { openExternal: () => {} },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}))

// The recording facade also pulls in the local API server and the renderer
// bridge; neither is under test here, and both drag in most of Electron.
mock.module('../local-server', () => ({ getApiUrl: () => 'http://127.0.0.1:1' }))
mock.module('../recording/bridge', () => ({
  startRecordingBridge: async () => {},
  stopRecordingBridge: async () => {},
  invokeRendererStart: async () => null,
  invokeRendererStop: async () => null,
}))

// The recorder itself is native (mic + the sysaudio binary): fake the manager
// so the only thing under test is what recording.ts does with its events.
mock.module('../recording/manager', () => ({
  RecordingManager: class {
    constructor(options: ManagerOptions) {
      managerOptions = options
    }
    status() {
      return { isRecording: false, id: null, audioPath: null, duration: 0 }
    }
    async startSession() {
      return { id: 's-1', primaryPath: '/tmp/s-1.wav' }
    }
    async stopSession() {
      return null
    }
  },
}))

const recording = await import('../recording')

/** One real manager event, exactly as the recorder emits it. */
function emit(evt: unknown): void {
  if (!managerOptions) throw new Error('the manager was never constructed')
  managerOptions.onEvent(evt)
}

describe('recording.ts dispatches a recording-state change', () => {
  test('on started, stopped and aborted — from the capture, not from the caller', () => {
    const changes: number[] = []
    const unsubscribe = recording.onRecordingStateChange(() => changes.push(Date.now()))

    // Constructs RecordingManager, which is where recording.ts installs the
    // onEvent handler. No startRecording() call: this must work for any path.
    recording.getRecordingStatus()
    expect(managerOptions).not.toBeNull()

    emit({ type: 'session-started', session: { id: 's-1', primaryPath: '/tmp/s-1.wav' } })
    expect(changes).toHaveLength(1)

    emit({
      type: 'session-stopped',
      session: { id: 's-1', primaryPath: '/tmp/s-1.wav' },
      duration: 5,
      micBytes: 0,
      systemBytes: 0,
      mixedCreated: false,
    })
    expect(changes).toHaveLength(2)

    emit({ type: 'session-aborted', id: 's-1', reason: 'qa' })
    expect(changes).toHaveLength(3)

    unsubscribe()
    emit({ type: 'session-aborted', id: 's-1', reason: 'qa' })
    expect(changes).toHaveLength(3)
  })
})
