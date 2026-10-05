// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Onboarding flow with the desktop permission steps: they only exist for the
 * local macOS shell, sit between `ai-config` and `destination`, and Skip on
 * them advances instead of finishing onboarding.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as React from 'react'
import * as ReactNativeWeb from 'react-native-web'
import * as apiStub from '../../../../test/stubs/api'

mock.module('react-native', () => ReactNativeWeb)

mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
  Button: ({ testID, onPress, disabled, children }: any) => (
    <button data-testid={testID} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}))

const replace = mock((_: unknown) => {})
mock.module('expo-router', () => ({
  useRouter: () => ({ replace, push: mock(() => {}), back: mock(() => {}) }),
}))

const saveLocalAccessPrefs = mock(async (_http: unknown, _patch: unknown) => ({}))
const finishCalls = mock(async () => ({}))
mock.module('../../../../lib/api', () => ({
  ...apiStub,
  getOnboardingMessage: (t: string) => t,
  api: new Proxy(
    { saveLocalAccessPrefs },
    {
      get: (target, key) =>
        key in target ? (target as any)[key] : async (...args: unknown[]) => finishCalls(...(args as [])),
    },
  ),
}))

mock.module('../../../../contexts/auth', () => ({
  useAuth: () => ({
    user: { id: 'u1', name: 'Ada Lovelace' },
    signOut: async () => {},
    updateUser: async () => {},
  }),
}))

const collection = (rows: unknown[]) => ({ all: rows, loadAll: async () => rows })
mock.module('../../../../contexts/domain', () => ({
  useDomainHttp: () => ({}),
  useDomainActions: () => ({ createWorkspace: async () => ({}) }),
  useWorkspaceCollection: () =>
    collection([
      { id: 'w-personal', name: 'Personal', kind: 'personal' },
      { id: 'w-team', name: "Ada's Workspace", kind: 'team' },
    ]),
  useMemberCollection: () => collection([{ workspaceId: 'w-team', role: 'owner', userId: 'u1' }]),
}))
mock.module('../../../../contexts/posthog', () => ({ usePostHogSafe: () => null }))
mock.module('../../../../lib/analytics', () => ({
  EVENTS: new Proxy({}, { get: (_t, k) => String(k) }),
  trackEvent: () => {},
}))
mock.module('../../../../lib/workspace-store', () => ({ setActiveWorkspaceId: () => {} }))
mock.module('../../../../hooks/useChatPrefill', () => ({ setChatPrefill: () => {} }))
mock.module('../../../branding/ShogoWordmark', () => ({ ShogoWordmark: () => null }))

// Heavy step bodies are irrelevant here.
mock.module('../../steps/NameInput', () => ({ NameInput: () => null }))
mock.module('../../steps/AIConfigForm', () => ({
  AIConfigForm: ({ onReadyChange }: { onReadyChange: (v: boolean) => void }) => {
    React.useEffect(() => onReadyChange(true), [onReadyChange])
    return <div data-testid="ai-config-body" />
  },
}))
mock.module('../DestinationStep', () => ({
  DestinationStep: () => <div data-testid="destination-body" />,
}))
mock.module('../TeamSetupStep', () => ({ TeamSetupStep: () => null }))
mock.module('../JoinedStep', () => ({ JoinedStep: () => null }))
mock.module('../AgentPickerStep', () => ({ AgentPickerStep: () => null }))
mock.module('../SettingUp', () => ({ SettingUp: () => <div data-testid="setting-up" /> }))

const { CloudOnboarding } = await import('../CloudOnboarding')

function installMacBridge() {
  ;(window as any).shogoDesktop = {
    isDesktop: true,
    platform: 'darwin',
    permissions: {
      getStatus: async () => ({ accessibility: 'denied', screen: 'denied', fullDisk: 'denied', mic: 'denied' }),
      request: async () => ({ state: 'denied', openedSettings: false }),
      openSettings: async () => {},
      listLocalApps: async () => [],
      relaunch: async () => {},
    },
  }
}

async function click(testId: string) {
  const el = await screen.findByTestId(testId)
  await waitFor(() => expect((el as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(el)
}

beforeEach(() => {
  replace.mockClear()
  saveLocalAccessPrefs.mockClear()
  finishCalls.mockClear()
})

afterEach(() => {
  cleanup()
  delete (window as any).shogoDesktop
})

describe('CloudOnboarding desktop permission steps', () => {
  test('omitted outside the macOS desktop shell', async () => {
    render(<CloudOnboarding localMode />)
    await click('onboarding-continue-ai-config')
    await screen.findByTestId('destination-body')
    expect(screen.queryByTestId('onboarding-skip-computer-use')).toBeNull()
  })

  test('omitted in cloud mode even on the macOS desktop', async () => {
    installMacBridge()
    render(<CloudOnboarding />)
    await screen.findByTestId('destination-body')
    expect(screen.queryByTestId('onboarding-skip-computer-use')).toBeNull()
  })

  test('appear after ai-config in order, and Skip advances without finishing', async () => {
    installMacBridge()
    render(<CloudOnboarding localMode />)

    await click('onboarding-continue-ai-config')
    // computer-use -> Skip records an explicit "off" and moves on.
    await click('onboarding-skip-computer-use')
    await waitFor(() => expect(saveLocalAccessPrefs).toHaveBeenCalledTimes(1))
    expect(saveLocalAccessPrefs.mock.calls[0][1]).toEqual({ computerUse: false })

    await click('onboarding-skip-files-apps')
    await click('onboarding-skip-dictation')

    await screen.findByTestId('destination-body')
    expect(screen.queryByTestId('setting-up')).toBeNull()
    expect(replace).not.toHaveBeenCalled()
    // Only computer-use persists on skip; files/dictation have nothing granted.
    expect(saveLocalAccessPrefs).toHaveBeenCalledTimes(1)
  })

  test('Continue without grants advances too', async () => {
    installMacBridge()
    render(<CloudOnboarding localMode />)
    await click('onboarding-continue-ai-config')
    await click('onboarding-continue-computer-use')
    await click('onboarding-continue-files-apps')
    await click('onboarding-continue-dictation')
    await screen.findByTestId('destination-body')
  })
})
