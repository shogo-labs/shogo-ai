// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What the marketing site's link does to onboarding (SHO-614).
 *
 * A visitor who typed "A booking page for my salon" on shogo.ai must see that
 * text on the build step, skip the team-setup step, get a visible countdown
 * before it builds itself, and be able to stop it. A device that never opened
 * the link reads the same intent from the account (`GET /api/onboarding/intent`).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as ReactNativeWeb from 'react-native-web'
import * as apiStub from '../../../../test/stubs/api'

mock.module('react-native', () => ReactNativeWeb)

mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
  Input: (props: any) => <input {...props} />,
  Button: ({ testID, onPress, disabled, children }: any) => (
    <button data-testid={testID} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}))

const replace = mock((_href: any) => {})
const push = mock((_href: any) => {})
mock.module('expo-router', () => ({
  useRouter: () => ({ replace, push, back: mock(() => {}) }),
}))

const prewarmWorkspaceRuntime = mock(async () => {})
const completeOnboarding = mock(async () => ({ ok: true }))
const createWorkspaceSession = mock(async () => ({ id: 'sess-1' }))
const getOnboardingIntent = mock(async () => null as any)
mock.module('../../../../lib/api', () => ({
  ...apiStub,
  api: new Proxy(
    { prewarmWorkspaceRuntime, completeOnboarding, createWorkspaceSession, getOnboardingIntent },
    { get: (target, key) => (key in target ? (target as any)[key] : async () => ({})) },
  ),
}))

let authUser: any = { id: 'u1', name: 'Ada Lovelace' }
mock.module('../../../../contexts/auth', () => ({
  useAuth: () => ({
    user: authUser,
    signOut: async () => {},
    updateUser: async () => {},
  }),
}))

const rows = { workspaces: [] as unknown[], members: [] as unknown[] }
const collection = (get: () => unknown[]) => ({
  get all() {
    return get()
  },
  loadAll: async () => get(),
})
mock.module('../../../../contexts/domain', () => ({
  useDomainHttp: () => ({}),
  useDomainActions: () => ({ createWorkspace: async () => ({}), updateWorkspace: async () => ({}), sendInvitation: async () => ({}) }),
  useWorkspaceCollection: () => collection(() => rows.workspaces),
  useMemberCollection: () => collection(() => rows.members),
}))
mock.module('../../../../contexts/posthog', () => ({ usePostHogSafe: () => null }))
const tracked: Array<{ event: string; props: any }> = []
mock.module('../../../../lib/analytics', () => ({
  EVENTS: new Proxy({}, { get: (_t, k) => String(k) }),
  trackEvent: (_p: unknown, event: string, props: any) => tracked.push({ event, props }),
}))
mock.module('../../../../lib/workspace-store', () => ({ setActiveWorkspaceId: () => {} }))
mock.module('../../../../hooks/useChatPrefill', () => ({ setChatPrefill: () => {} }))
mock.module('../../../branding/ShogoWordmark', () => ({ ShogoWordmark: () => null }))
mock.module('../../steps/NameInput', () => ({ NameInput: () => null }))
mock.module('../../steps/AIConfigForm', () => ({ AIConfigForm: () => null }))
mock.module('../../steps/TeamSetupStep', () => ({ TeamSetupStep: () => <div data-testid="team-setup" /> }))
mock.module('../../cloud/JoinedStep', () => ({ JoinedStep: () => null }))
mock.module('../../cloud/SettingUp', () => ({ SettingUp: ({ message }: any) => <div data-testid="setting-up">{message}</div> }))

const { SIGNUP_INTENT_STORAGE_KEY } = await import('../../../../lib/signup-intent')
const { CloudOnboarding } = await import('../CloudOnboarding')

const PROMPT = 'A booking page for my salon'

function seedCapturedIntent(intent: Record<string, unknown>): void {
  window.localStorage.setItem(
    SIGNUP_INTENT_STORAGE_KEY,
    JSON.stringify({ ...intent, capturedAt: Date.now() }),
  )
}

function freshAccount(): void {
  authUser = { id: 'u1', name: 'Ada Lovelace', createdAt: new Date().toISOString() }
}

function oldAccount(): void {
  authUser = {
    id: 'u1',
    name: 'Ada Lovelace',
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  }
}

function promptInput(): HTMLTextAreaElement {
  return screen.getByTestId('onboarding-build-prompt-input') as unknown as HTMLTextAreaElement
}

beforeEach(() => {
  window.localStorage.clear()
  tracked.length = 0
  replace.mockClear()
  push.mockClear()
  completeOnboarding.mockClear()
  createWorkspaceSession.mockClear()
  getOnboardingIntent.mockClear()
  getOnboardingIntent.mockImplementation(async () => null)
  freshAccount()
  rows.workspaces = [
    { id: 'w-personal', name: 'Personal', kind: 'personal' },
    { id: 'w-team', name: "Ada's Workspace", kind: 'team' },
  ]
  rows.members = [{ workspaceId: 'w-team', role: 'owner', userId: 'u1' }]
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('a prompt carried from the marketing site', () => {
  test('prefills the build step, skips team setup, and counts down with an escape', async () => {
    seedCapturedIntent({ prompt: PROMPT, intent: 'hero_prompt' })
    render(<CloudOnboarding />)

    // Straight to the build step — no workspace naming, no invites.
    await screen.findByText('What do you want to build?')
    expect(screen.queryByTestId('team-setup')).toBeNull()
    expect(promptInput().value).toBe(PROMPT)

    // The countdown is visible and offers the way out.
    const countdown = await screen.findByTestId('onboarding-auto-run')
    expect(countdown.textContent).toContain('Building this in')
    expect(screen.getByText('Edit first')).toBeTruthy()

    // "Edit first" stops it for good; nothing is sent.
    fireEvent.click(screen.getByTestId('onboarding-edit-first'))
    await waitFor(() => expect(screen.queryByTestId('onboarding-auto-run')).toBeNull())
    expect(completeOnboarding).not.toHaveBeenCalled()
    expect(createWorkspaceSession).not.toHaveBeenCalled()
  })

  test('the edited text is what gets sent', async () => {
    seedCapturedIntent({ prompt: PROMPT })
    render(<CloudOnboarding />)
    await screen.findByText('What do you want to build?')
    await screen.findByTestId('onboarding-auto-run')

    fireEvent.click(screen.getByTestId('onboarding-edit-first'))
    fireEvent.change(promptInput(), { target: { value: 'A booking page for my barber shop' } })
    fireEvent.click(screen.getByTestId('onboarding-continue-build-prompt'))

    await waitFor(() => expect(replace).toHaveBeenCalled())
    expect(createWorkspaceSession).toHaveBeenCalledTimes(1)
    const [route] = replace.mock.calls[replace.mock.calls.length - 1] as any[]
    expect(route.pathname).toBe('/(app)/agent')
    expect(route.params.initialMessage).toContain('A booking page for my barber shop')
    expect(route.params.initialMessage).not.toContain('my salon')
  })

  test('builds itself when the countdown runs out', async () => {
    seedCapturedIntent({ prompt: PROMPT })
    render(<CloudOnboarding />)
    await screen.findByText('What do you want to build?')
    await screen.findByTestId('onboarding-auto-run')

    await waitFor(() => expect(completeOnboarding).toHaveBeenCalled(), { timeout: 8000 })
    expect(createWorkspaceSession).toHaveBeenCalledTimes(1)
    const [route] = replace.mock.calls[replace.mock.calls.length - 1] as any[]
    expect(route.pathname).toBe('/(app)/agent')
    expect(route.params.initialMessage).toContain(PROMPT)
    // The analytics say how it ended up running.
    const completed = tracked.find((t) => t.event === 'ONBOARDING_COMPLETED')
    expect(completed?.props).toMatchObject({ carried_prompt: true, auto_ran: true, edited: false })
  }, 20000)

  test('an older account gets the prefill but never an auto-sent message', async () => {
    oldAccount()
    seedCapturedIntent({ prompt: PROMPT })
    render(<CloudOnboarding />)
    await screen.findByText('What do you want to build?')
    expect(promptInput().value).toBe(PROMPT)
    // No countdown at all: a crafted link cannot run a prompt in an existing
    // workspace.
    expect(screen.queryByTestId('onboarding-auto-run')).toBeNull()
    expect(completeOnboarding).not.toHaveBeenCalled()
  })

  test('reads the account copy when this browser never opened the link', async () => {
    getOnboardingIntent.mockImplementation(async () => ({ prompt: 'A client intake form that books a consult' }))
    render(<CloudOnboarding />)

    await screen.findByText('What do you want to build?')
    await waitFor(() => expect(promptInput().value).toBe('A client intake form that books a consult'))
    expect(getOnboardingIntent).toHaveBeenCalledTimes(1)
  })

  test('a template-only link behaves as it always has', async () => {
    window.localStorage.setItem('pending_template_id', 'invoice-generator')
    render(<CloudOnboarding />)

    // The old flow keeps its team step and seeds the prompt from the slug.
    await screen.findByText('Set up your team workspace')
    expect(screen.queryByTestId('onboarding-auto-run')).toBeNull()
  })
})
