// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The three desktop onboarding steps against a stubbed `window.shogoDesktop`
 * bridge: granted / denied rows, the Settings round-trip, relaunch hint, the
 * manual Full Disk confirm and "Not installed" apps.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as ReactNativeWeb from 'react-native-web'

mock.module('react-native', () => ReactNativeWeb)

// The real primitives pull in the flow-typed `react-native` entry; a plain
// button is enough to exercise the steps.
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
  Button: ({ testID, onPress, disabled, children, accessibilityLabel }: any) => (
    <button data-testid={testID} aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}))

const { ComputerUseStep } = await import('../ComputerUseStep')
const { FilesAppsStep } = await import('../FilesAppsStep')
const { DictationStep } = await import('../DictationStep')
const { defaultLocalAccess } = await import('../../../../lib/local-access')

type Status = Record<'accessibility' | 'screen' | 'fullDisk' | 'mic', string>

let status: Status
const request = mock(async (_kind: string) => ({ state: 'denied', openedSettings: true }) as any)
const relaunch = mock(async () => {})
const listLocalApps = mock(async () => [
  { id: 'mail', name: 'Mail', installed: true },
  { id: 'messages', name: 'Messages', installed: true },
  { id: 'notes', name: 'Notes', installed: true },
  { id: 'whatsapp', name: 'WhatsApp', installed: false },
])

function installBridge() {
  ;(window as any).shogoDesktop = {
    isDesktop: true,
    platform: 'darwin',
    permissions: {
      getStatus: async () => ({ ...status }),
      request,
      openSettings: mock(async () => {}),
      listLocalApps,
      relaunch,
    },
  }
}

beforeEach(() => {
  status = { accessibility: 'denied', screen: 'denied', fullDisk: 'denied', mic: 'denied' }
  request.mockClear()
  relaunch.mockClear()
  installBridge()
})

afterEach(() => {
  cleanup()
  delete (window as any).shogoDesktop
})

describe('ComputerUseStep', () => {
  test('shows Allow for denied rows and a check once granted', async () => {
    status = { ...status, accessibility: 'granted', screen: 'denied' }
    render(<ComputerUseStep />)
    await screen.findByTestId('permission-granted-accessibility')
    expect(screen.queryByTestId('permission-allow-accessibility')).toBeNull()
    expect(screen.getByTestId('permission-allow-screen')).toBeTruthy()
  })

  test('Allow requests the permission and, after opening Settings, offers a restart', async () => {
    status = { ...status, accessibility: 'granted', screen: 'denied' }
    render(<ComputerUseStep />)
    fireEvent.click(await screen.findByTestId('permission-allow-screen'))
    await waitFor(() => expect(request).toHaveBeenCalledWith('screen'))
    const restart = await screen.findByTestId('permission-relaunch')
    fireEvent.click(restart)
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1))
  })

  test('reports the live status to its parent', async () => {
    status = { ...status, accessibility: 'granted', screen: 'granted' }
    const seen: any[] = []
    render(<ComputerUseStep onStatusChange={(s) => seen.push(s)} />)
    await waitFor(() => expect(seen.at(-1)?.screen).toBe('granted'))
    expect(seen.at(-1)?.accessibility).toBe('granted')
  })
})

describe('FilesAppsStep', () => {
  test('hides the app list until Full Disk Access is granted', async () => {
    render(<FilesAppsStep value={defaultLocalAccess().apps} onChange={() => {}} />)
    await screen.findByTestId('permission-allow-fullDisk')
    expect(screen.queryByTestId('local-apps-list')).toBeNull()
  })

  test('lists apps with per-app access and flags apps that are not installed', async () => {
    status = { ...status, fullDisk: 'granted' }
    const changes: any[] = []
    render(
      <FilesAppsStep
        value={defaultLocalAccess().apps}
        onChange={(id, access) => changes.push([id, access])}
      />,
    )
    await screen.findByTestId('local-apps-list')
    expect(screen.getByTestId('local-app-whatsapp-not-installed')).toBeTruthy()
    expect(screen.queryByTestId('local-app-whatsapp-access')).toBeNull()

    fireEvent.click(screen.getByTestId('local-app-mail-access'))
    fireEvent.click(await screen.findByTestId('local-app-mail-access-option-off'))
    expect(changes).toEqual([['mail', 'off']])
  })

  test('"I\'ve turned it on" unlocks the app list when the probe is inconclusive', async () => {
    status = { ...status, fullDisk: 'not-determined' }
    render(<FilesAppsStep value={defaultLocalAccess().apps} onChange={() => {}} />)
    fireEvent.click(await screen.findByTestId('permission-allow-fullDisk'))
    await waitFor(() => expect(request).toHaveBeenCalledWith('fullDisk'))
    fireEvent.click(await screen.findByTestId('full-disk-confirm'))
    await screen.findByTestId('local-apps-list')
  })
})

describe('DictationStep', () => {
  const value = { pushToTalk: 'Fn', handsFree: null }

  test('shortcuts appear only after microphone access', async () => {
    render(<DictationStep value={value} onChange={() => {}} />)
    await screen.findByTestId('permission-allow-mic')
    expect(screen.queryByTestId('dictation-shortcuts')).toBeNull()
  })

  test('granted mic shows shortcuts and changing one reports the new config', async () => {
    status = { ...status, mic: 'granted', accessibility: 'granted' }
    const changes: any[] = []
    render(<DictationStep value={value} onChange={(c) => changes.push(c)} />)
    await screen.findByTestId('dictation-shortcuts')
    fireEvent.click(screen.getByTestId('dictation-push-to-talk'))
    fireEvent.click(await screen.findByTestId('dictation-push-to-talk-option-Option+Space'))
    expect(changes).toEqual([{ pushToTalk: 'Option+Space', handsFree: null }])
  })
})
