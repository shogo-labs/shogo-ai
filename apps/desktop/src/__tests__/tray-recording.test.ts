// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The menu-bar item's recording transition (SHO-555 round 1).
 *
 * QA caught the regression this pins: starting or stopping a recording never
 * reached the tray, so the timer and the recording icon never appeared and the
 * menu kept offering "Start Recording" while capture was running — you could
 * start from the menu and not stop from it.
 *
 * Electron and `./recording` are mocked (neither runs under `bun test`); the
 * menu is asserted through the real template builder the Tray renders.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shogo-tray-test-'))

class FakeTray {
  static instances: FakeTray[] = []
  image: unknown = null
  title = ''
  toolTip = ''
  template: unknown = null
  destroyed = false
  constructor(image: unknown) {
    this.image = image
    FakeTray.instances.push(this)
  }
  setImage(image: unknown): void {
    this.image = image
  }
  setTitle(title: string): void {
    this.title = title
  }
  setToolTip(text: string): void {
    this.toolTip = text
  }
  setContextMenu(template: unknown): void {
    this.template = template
  }
  on(): void {}
  popUpContextMenu(): void {}
  destroy(): void {
    this.destroyed = true
  }
}

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => path.resolve(import.meta.dir, '..', '..'),
    getPath: () => userDataDir,
    quit: () => {},
    focus: () => {},
  },
  Tray: FakeTray,
  Menu: { buildFromTemplate: (template: unknown) => template },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true, setTemplateImage: () => {} }),
    createEmpty: () => ({ isEmpty: () => true }),
  },
}))

const recordingListeners = new Set<() => void>()
let recordingStatus = { isRecording: false, id: null as string | null, duration: 0, audioPath: null as string | null }

mock.module('../recording', () => ({
  startRecording: async () => ({ id: 'rec-1', audioPath: '/tmp/rec-1.wav' }),
  stopRecording: async () => null,
  getRecordingStatus: () => recordingStatus,
  setMeetingConfig: async () => {},
  onRecordingStateChange: (listener: () => void) => {
    recordingListeners.add(listener)
    return () => {
      recordingListeners.delete(listener)
    }
  },
}))

const tray = await import('../tray')
const config = await import('../config')

/** What `handleRecordingEvent` does on session-started / -stopped / -aborted. */
function recordingChanged(next: { isRecording: boolean; duration: number }): void {
  recordingStatus = {
    isRecording: next.isRecording,
    id: next.isRecording ? 'rec-1' : null,
    duration: next.duration,
    audioPath: next.isRecording ? '/tmp/rec-1.wav' : null,
  }
  for (const listener of recordingListeners) listener()
}

function startTray(): FakeTray {
  tray.createTray({
    localMode: true,
    openChat: () => {},
    newChat: () => {},
    clearNotifications: () => {},
    openApp: () => {},
    openSettings: () => {},
  })
  const instance = FakeTray.instances[FakeTray.instances.length - 1]!
  return instance
}

afterEach(() => {
  tray.destroyTray()
  fs.rmSync(path.join(userDataDir, 'config.json'), { force: true })
  recordingStatus = { isRecording: false, id: null, duration: 0, audioPath: null }
})

describe('menu-bar recording transition', () => {
  it('shows the timer and Stop Recording as soon as a capture starts', () => {
    const instance = startTray()
    expect(tray.describeTrayMenuForTests()).toContain('-- Start Recording')

    recordingChanged({ isRecording: true, duration: 65 })

    expect(instance.title).toBe('1:05')
    expect(instance.toolTip).toBe('Shogo — recording 1:05')
    const menu = tray.describeTrayMenuForTests()
    expect(menu).toContain('-- Stop Recording')
    expect(menu).toContain('-- Recording 1:05 (disabled)')
    expect(menu).not.toContain('-- Start Recording')
  })

  it('goes back to the attention count when the capture stops', () => {
    const instance = startTray()
    tray.setTrayModel({
      pinned: [],
      groups: [
        {
          title: 'Shogo Dev 5',
          rows: [
            {
              sessionId: 's-1',
              projectId: null,
              title: 'Waiting on you',
              status: 'needs_you',
              path: '/(app)/agent?chatSessionId=s-1',
            },
          ],
        },
      ],
      recent: [],
      attentionCount: 1,
      canClear: false,
    })
    expect(instance.title).toBe('1')

    recordingChanged({ isRecording: true, duration: 12 })
    expect(instance.title).toBe('0:12')

    // A chat finishing mid-recording must not replace the timer with the count.
    tray.setTrayModel({
      pinned: ['a', 'b', 'c', 'd'].map((id) => ({
        sessionId: `p-${id}`,
        projectId: null,
        title: `Unopened ${id}`,
        status: 'new' as const,
        path: `/(app)/agent?chatSessionId=p-${id}`,
      })),
      groups: [],
      recent: [],
      attentionCount: 4,
      canClear: true,
    })
    expect(instance.title).toBe('0:12')

    recordingChanged({ isRecording: false, duration: 12 })
    expect(instance.title).toBe('4')
    expect(tray.describeTrayMenuForTests()).toContain('-- Start Recording')
  })

  it('drops the count when Show Count is switched off, without a rebuild', () => {
    const instance = startTray()
    tray.setTrayModel({
      pinned: [],
      groups: [],
      recent: [
        {
          sessionId: 's-2',
          projectId: null,
          title: 'Unopened reply',
          status: 'new',
          path: '/(app)/agent?chatSessionId=s-2',
        },
      ],
      attentionCount: 1,
      canClear: true,
    })
    expect(instance.title).toBe('1')

    // Settings (another window) writes the pref; the next publish must pick it
    // up rather than showing a remembered value.
    config.writeConfig({ tray: { showCount: false } })
    recordingChanged({ isRecording: false, duration: 0 })
    tray.setTrayModel({
      pinned: [],
      groups: [],
      recent: [
        {
          sessionId: 's-2',
          projectId: null,
          title: 'Unopened reply',
          status: 'new',
          path: '/(app)/agent?chatSessionId=s-2',
        },
      ],
      attentionCount: 1,
      canClear: true,
    })
    expect(instance.title).toBe('')
  })
})
