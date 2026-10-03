// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'
import {
  getFullDiskState,
  getPermissionStatus,
  listLocalApps,
  openPermissionSettings,
  requestPermission,
  MAC_SETTINGS_URLS,
  type OsPermissionDeps,
} from '../os-permissions'

function errno(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function makeDeps(overrides: Partial<OsPermissionDeps> = {}): OsPermissionDeps & {
  openExternal: ReturnType<typeof mock>
} {
  const openExternal = mock(async (_url: string) => {})
  return {
    platform: 'darwin',
    homeDir: '/Users/test',
    isTrustedAccessibilityClient: () => false,
    getMediaAccessStatus: () => 'not-determined',
    askForMicrophoneAccess: async () => true,
    triggerScreenCapturePrompt: async () => {},
    probeRead: async () => {
      throw errno('ENOENT')
    },
    openExternal,
    ...overrides,
  } as OsPermissionDeps & { openExternal: ReturnType<typeof mock> }
}

describe('getFullDiskState', () => {
  test('unsupported off macOS', async () => {
    expect(await getFullDiskState(makeDeps({ platform: 'linux' }))).toBe('unsupported')
  })

  test('EPERM on a protected path means denied', async () => {
    const d = makeDeps({ probeRead: async () => { throw errno('EPERM') } })
    expect(await getFullDiskState(d)).toBe('denied')
  })

  test('a readable protected path means granted', async () => {
    const d = makeDeps({ probeRead: async () => {} })
    expect(await getFullDiskState(d)).toBe('granted')
  })

  test('ENOENT everywhere is inconclusive; later paths are tried', async () => {
    const seen: string[] = []
    const d = makeDeps({
      probeRead: async (p) => {
        seen.push(p)
        if (seen.length < 3) throw errno('ENOENT')
        throw errno('EACCES')
      },
    })
    expect(await getFullDiskState(d)).toBe('denied')
    expect(seen.length).toBe(3)
  })

  test('all paths missing is not-determined', async () => {
    expect(await getFullDiskState(makeDeps())).toBe('not-determined')
  })
})

describe('getPermissionStatus', () => {
  test('non-macOS: everything unsupported except mic', async () => {
    const s = await getPermissionStatus(makeDeps({ platform: 'win32' }))
    expect(s).toEqual({ accessibility: 'unsupported', screen: 'unsupported', fullDisk: 'unsupported', mic: 'granted' })
  })

  test('maps each macOS source', async () => {
    const s = await getPermissionStatus(
      makeDeps({
        isTrustedAccessibilityClient: () => true,
        getMediaAccessStatus: (t) => (t === 'screen' ? 'denied' : 'granted'),
        probeRead: async () => {},
      }),
    )
    expect(s).toEqual({ accessibility: 'granted', screen: 'denied', fullDisk: 'granted', mic: 'granted' })
  })

  test('restricted media status is reported as denied', async () => {
    const s = await getPermissionStatus(makeDeps({ getMediaAccessStatus: () => 'restricted' }))
    expect(s.screen).toBe('denied')
    expect(s.mic).toBe('denied')
  })

  test('a throwing accessibility check degrades to denied', async () => {
    const s = await getPermissionStatus(
      makeDeps({ isTrustedAccessibilityClient: () => { throw new Error('boom') } }),
    )
    expect(s.accessibility).toBe('denied')
  })
})

describe('requestPermission', () => {
  test('already granted does nothing', async () => {
    const d = makeDeps({ isTrustedAccessibilityClient: () => true })
    const r = await requestPermission(d, 'accessibility')
    expect(r).toEqual({ state: 'granted', openedSettings: false })
    expect(d.openExternal).not.toHaveBeenCalled()
  })

  test('accessibility: prompts, then opens Settings when still untrusted', async () => {
    const prompts: boolean[] = []
    const d = makeDeps({
      isTrustedAccessibilityClient: (prompt) => {
        prompts.push(prompt)
        return false
      },
    })
    const r = await requestPermission(d, 'accessibility')
    expect(prompts).toContain(true)
    expect(r.openedSettings).toBe(true)
    expect(d.openExternal).toHaveBeenCalledWith(MAC_SETTINGS_URLS.accessibility)
  })

  test('screen: not-determined triggers the capture prompt once', async () => {
    const trigger = mock(async () => {})
    const d = makeDeps({ triggerScreenCapturePrompt: trigger, getMediaAccessStatus: () => 'not-determined' })
    const r = await requestPermission(d, 'screen')
    expect(trigger).toHaveBeenCalledTimes(1)
    expect(r.openedSettings).toBe(true)
  })

  test('screen: denied skips the prompt and opens Settings', async () => {
    const trigger = mock(async () => {})
    const d = makeDeps({ triggerScreenCapturePrompt: trigger, getMediaAccessStatus: () => 'denied' })
    const r = await requestPermission(d, 'screen')
    expect(trigger).not.toHaveBeenCalled()
    expect(r).toEqual({ state: 'denied', openedSettings: true })
    expect(d.openExternal).toHaveBeenCalledWith(MAC_SETTINGS_URLS.screen)
  })

  test('mic: asks natively when not-determined', async () => {
    const d = makeDeps({ getMediaAccessStatus: () => 'not-determined', askForMicrophoneAccess: async () => true })
    expect(await requestPermission(d, 'mic')).toEqual({ state: 'granted', openedSettings: false })
  })

  test('mic: denied opens Settings', async () => {
    const d = makeDeps({ getMediaAccessStatus: () => 'denied' })
    const r = await requestPermission(d, 'mic')
    expect(r.openedSettings).toBe(true)
  })

  test('fullDisk always opens Settings', async () => {
    const d = makeDeps({ probeRead: async () => { throw errno('EPERM') } })
    const r = await requestPermission(d, 'fullDisk')
    expect(r.openedSettings).toBe(true)
    expect(d.openExternal).toHaveBeenCalledWith(MAC_SETTINGS_URLS.fullDisk)
  })
})

describe('openPermissionSettings', () => {
  test('no-op off macOS', async () => {
    const d = makeDeps({ platform: 'win32' })
    expect(await openPermissionSettings(d, 'screen')).toBe(false)
    expect(d.openExternal).not.toHaveBeenCalled()
  })
})

describe('listLocalApps', () => {
  test('detects installed apps in system and user locations', async () => {
    const present = new Set(['/System/Applications/Mail.app', '/Users/test/Applications/WhatsApp.app'])
    const apps = await listLocalApps({
      platform: 'darwin',
      homeDir: '/Users/test',
      exists: async (p) => present.has(p),
    })
    expect(apps.map((a) => [a.id, a.installed])).toEqual([
      ['mail', true],
      ['messages', false],
      ['notes', false],
      ['whatsapp', true],
    ])
  })

  test('nothing is installed off macOS', async () => {
    const apps = await listLocalApps({ platform: 'linux', homeDir: '/h', exists: async () => true })
    expect(apps.every((a) => !a.installed)).toBe(true)
  })
})
