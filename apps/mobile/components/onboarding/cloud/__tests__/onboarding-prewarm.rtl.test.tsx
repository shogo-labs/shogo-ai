// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Onboarding warms the destination workspace's agent runtime as soon as the
 * workspaces are loaded: the user's own team workspace, or the one they were
 * invited into.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

mock.module('expo-router', () => ({
  useRouter: () => ({ replace: mock(() => {}), push: mock(() => {}), back: mock(() => {}) }),
}))

const prewarmWorkspaceRuntime = mock(async (_http: unknown, _workspaceId: string, _opts?: unknown) => {})
mock.module('../../../../lib/api', () => ({
  ...apiStub,
  api: new Proxy(
    { prewarmWorkspaceRuntime },
    { get: (target, key) => (key in target ? (target as any)[key] : async () => ({})) },
  ),
}))

mock.module('../../../../contexts/auth', () => ({
  useAuth: () => ({
    user: { id: 'u1', name: 'Ada Lovelace' },
    signOut: async () => {},
    updateUser: async () => {},
  }),
}))

const rows = {
  workspaces: [] as unknown[],
  members: [] as unknown[],
}
const collection = (get: () => unknown[]) => ({
  get all() {
    return get()
  },
  loadAll: async () => get(),
})
mock.module('../../../../contexts/domain', () => ({
  useDomainHttp: () => ({}),
  useDomainActions: () => ({ createWorkspace: async () => ({}) }),
  useWorkspaceCollection: () => collection(() => rows.workspaces),
  useMemberCollection: () => collection(() => rows.members),
}))
mock.module('../../../../contexts/posthog', () => ({ usePostHogSafe: () => null }))
mock.module('../../../../lib/analytics', () => ({
  EVENTS: new Proxy({}, { get: (_t, k) => String(k) }),
  trackEvent: () => {},
}))
mock.module('../../../../lib/workspace-store', () => ({ setActiveWorkspaceId: () => {} }))
mock.module('../../../../hooks/useChatPrefill', () => ({ setChatPrefill: () => {} }))
mock.module('../../../branding/ShogoWordmark', () => ({ ShogoWordmark: () => null }))

mock.module('../../steps/NameInput', () => ({ NameInput: () => null }))
mock.module('../../steps/AIConfigForm', () => ({ AIConfigForm: () => null }))
mock.module('../TeamSetupStep', () => ({ TeamSetupStep: () => null }))
mock.module('../JoinedStep', () => ({ JoinedStep: () => null }))
mock.module('../BuildPromptStep', () => ({ BuildPromptStep: () => null }))
mock.module('../SettingUp', () => ({ SettingUp: () => <div data-testid="setting-up" /> }))

const { CloudOnboarding } = await import('../CloudOnboarding')

beforeEach(() => {
  prewarmWorkspaceRuntime.mockClear()
})

afterEach(() => {
  cleanup()
})

describe('CloudOnboarding workspace agent prewarm', () => {
  test('warms the owned team workspace once', async () => {
    rows.workspaces = [
      { id: 'w-personal', name: 'Personal', kind: 'personal' },
      { id: 'w-team', name: "Ada's Workspace", kind: 'team' },
    ]
    rows.members = [{ workspaceId: 'w-team', role: 'owner', userId: 'u1' }]

    render(<CloudOnboarding />)
    await screen.findByText('Set up your team workspace')
    await waitFor(() => expect(prewarmWorkspaceRuntime).toHaveBeenCalledTimes(1))
    expect(prewarmWorkspaceRuntime.mock.calls[0]![1]).toBe('w-team')
    expect(prewarmWorkspaceRuntime.mock.calls[0]![2]).toEqual({ source: 'onboarding' })
  })

  test('warms the workspace an invited user joined', async () => {
    rows.workspaces = [
      { id: 'w-personal', name: 'Personal', kind: 'personal' },
      { id: 'w-own', name: "Ada's Workspace", kind: 'team' },
      { id: 'w-joined', name: 'Analytical Engines', kind: 'team' },
    ]
    rows.members = [
      { workspaceId: 'w-own', role: 'owner', userId: 'u1' },
      { workspaceId: 'w-joined', role: 'member', userId: 'u1' },
    ]

    render(<CloudOnboarding />)
    await screen.findByText("You've joined Analytical Engines")
    await waitFor(() => expect(prewarmWorkspaceRuntime).toHaveBeenCalledTimes(1))
    expect(prewarmWorkspaceRuntime.mock.calls[0]![1]).toBe('w-joined')
    expect(prewarmWorkspaceRuntime.mock.calls[0]![2]).toEqual({ source: 'onboarding' })
  })
})
