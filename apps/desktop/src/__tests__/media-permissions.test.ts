// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'
import { ensureMediaAccess, ensureMicAccess, type MediaDevice, type MicAccessDeps } from '../media-permissions'

function deps(overrides: Partial<MicAccessDeps> & { status?: string; ask?: boolean | Error } = {}) {
  const getMediaAccessStatus = mock((_type: MediaDevice) => overrides.status ?? 'not-determined')
  const askForMediaAccess = mock(async (_type: MediaDevice) => {
    if (overrides.ask instanceof Error) throw overrides.ask
    return overrides.ask ?? true
  })
  return {
    deps: {
      platform: overrides.platform ?? 'darwin',
      getMediaAccessStatus: overrides.getMediaAccessStatus ?? getMediaAccessStatus,
      askForMediaAccess,
    } as MicAccessDeps,
    getMediaAccessStatus,
    askForMediaAccess,
  }
}

describe('ensureMicAccess', () => {
  test('is a no-op outside macOS', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const d = deps({ platform })
      expect(await ensureMicAccess(d.deps)).toBe('granted')
      expect(d.getMediaAccessStatus).not.toHaveBeenCalled()
      expect(d.askForMediaAccess).not.toHaveBeenCalled()
    }
  })

  test('already granted: does not prompt', async () => {
    const d = deps({ status: 'granted' })
    expect(await ensureMicAccess(d.deps)).toBe('granted')
    expect(d.askForMediaAccess).not.toHaveBeenCalled()
  })

  test('denied: reports denied without prompting (macOS will not prompt again)', async () => {
    const d = deps({ status: 'denied' })
    expect(await ensureMicAccess(d.deps)).toBe('denied')
    expect(d.askForMediaAccess).not.toHaveBeenCalled()
  })

  test('restricted (MDM / parental controls): reports restricted without prompting', async () => {
    const d = deps({ status: 'restricted' })
    expect(await ensureMicAccess(d.deps)).toBe('restricted')
    expect(d.askForMediaAccess).not.toHaveBeenCalled()
  })

  test('not-determined: prompts and returns granted when the user allows', async () => {
    const d = deps({ status: 'not-determined', ask: true })
    expect(await ensureMicAccess(d.deps)).toBe('granted')
    expect(d.askForMediaAccess).toHaveBeenCalledWith('microphone')
  })

  test('not-determined: returns denied when the user declines', async () => {
    const d = deps({ status: 'not-determined', ask: false })
    expect(await ensureMicAccess(d.deps)).toBe('denied')
  })

  test('treats a failing prompt as denied', async () => {
    const d = deps({ status: 'not-determined', ask: new Error('boom') })
    expect(await ensureMicAccess(d.deps)).toBe('denied')
  })

  test('treats a failing status read as denied', async () => {
    const d = deps({
      getMediaAccessStatus: () => {
        throw new Error('no TCC')
      },
    })
    expect(await ensureMicAccess(d.deps)).toBe('denied')
    expect(d.askForMediaAccess).not.toHaveBeenCalled()
  })
})

describe('ensureMediaAccess', () => {
  test('asks the OS about the camera for video', async () => {
    const d = deps({ status: 'not-determined', ask: true })
    expect(await ensureMediaAccess(d.deps, 'camera')).toBe('granted')
    expect(d.getMediaAccessStatus).toHaveBeenCalledWith('camera')
    expect(d.askForMediaAccess).toHaveBeenCalledWith('camera')
  })

  test('a denied camera stays denied', async () => {
    const d = deps({ status: 'denied' })
    expect(await ensureMediaAccess(d.deps, 'camera')).toBe('denied')
    expect(d.askForMediaAccess).not.toHaveBeenCalled()
  })
})
