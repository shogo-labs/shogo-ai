// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AC10 — new-workspace.tsx included workspace card (SHO-474).
 *
 * Verifies two states of the included-workspace section:
 *   1. With room on a Basic plan — shows the used/limit line
 *      "Basic includes 3 workspaces · 1 of 3 used".
 *   2. At cap on Basic — pooledWorkspaceParent is null, atCapParent is set →
 *      shows the amber upgrade card mentioning the limit and used count.
 *
 * Run: bun test apps/mobile/app/(app)/__tests__/sho-474-new-workspace-included.rtl.test.tsx
 */

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

// ── Platform mocks ──────────────────────────────────────────────────────────

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    View: ({ testID, children, ...rest }: any) =>
      createElement('div', { ...rest, 'data-testid': testID }, children),
    Text: ({ testID, children, ...rest }: any) =>
      createElement('span', { ...rest, 'data-testid': testID }, children),
    Pressable: ({ testID, children, onPress, ...rest }: any) =>
      createElement('button', { ...rest, 'data-testid': testID, onClick: onPress }, children),
    ScrollView: ({ children }: any) => createElement('div', null, children),
    TextInput: (props: any) => createElement('input', props),
    KeyboardAvoidingView: ({ children }: any) => createElement('div', null, children),
    useWindowDimensions: () => ({ width: 1024, height: 768, scale: 1, fontScale: 1 }),
  } as any),
)

const passthrough = ({ children }: any) => createElement('div', null, children)

mock.module('@shogo/shared-ui/primitives', () => ({
  Card: ({ children, testID, className }: any) =>
    createElement('div', { 'data-testid': testID, className }, children),
  CardContent: passthrough,
  Badge: passthrough,
  Button: ({ children, onPress, testID, disabled }: any) =>
    createElement('button', { 'data-testid': testID, onClick: onPress, 'aria-disabled': disabled }, children),
  cn: (...a: unknown[]) => a.filter(Boolean).join(' '),
  Separator: () => createElement('hr', null, null),
  Input: (props: any) => createElement('input', props),
  Switch: ({ checked, onCheckedChange }: any) =>
    createElement('input', { type: 'checkbox', checked, onChange: () => onCheckedChange?.(!checked) }),
  PressableScale: ({ children, onPress, testID }: any) =>
    createElement('button', { 'data-testid': testID, onClick: onPress }, children),
  Skeleton: () => createElement('div', null, null),
  Progress: passthrough,
  Avatar: passthrough,
  Alert: passthrough,
  AlertTitle: passthrough,
  AlertDescription: passthrough,
  Checkbox: (props: any) => createElement('input', { type: 'checkbox', ...props }),
}))

mock.module('expo-web-browser', () => ({ openBrowserAsync: async () => ({}) }))
mock.module('expo-linking', () => ({ createURL: () => '', openURL: async () => true }))
mock.module('expo-router', () => ({
  useRouter: () => ({ push: () => {}, back: () => {}, replace: () => {} }),
  useLocalSearchParams: () => ({}),
}))
mock.module('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
mock.module('lucide-react-native', () => ({
  ArrowLeft: () => null, Building2: () => null, Crown: () => null,
}))
mock.module('../../../contexts/auth', () => ({
  useAuth: () => ({ user: { id: 'u1' }, isLoading: false }),
}))
mock.module('../../../contexts/domain', () => ({
  useWorkspaceCollection: () => ({ all: [], isLoading: false, loadAll: async () => {} }),
  useDomainHttp: () => ({}),
}))
mock.module('../../../hooks/useActiveWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: { id: 'ws1', name: 'Acme' } }),
}))
mock.module('../../../lib/api', () => ({
  api: {
    getWorkspacePlans: async () => ({}),
    listInvoices: async () => [],
    getRegionalPricing: async () => null,
    createCheckoutSession: async () => ({}),
    createPortalSession: async () => ({}),
  },
}))
mock.module('../../../lib/rewardful', () => ({ getRewardfulReferral: () => null }))
mock.module('../../../lib/tracking', () => ({
  trackInitiateCheckout: () => {},
  trackPurchase: () => {},
}))
const pricing = { monthly: 20, annual: 180, annualSavingsPct: 25 }
mock.module('../../../lib/billing-config', () => ({
  PLAN_PRICING: { basic: pricing, pro: pricing, business: pricing },
  SEAT_INCLUDED_USD: { free: 0, basic: 0, pro: 0, business: 0, enterprise: 0 },
  BUSINESS_FEATURES: [],
  ENTERPRISE_FEATURES: [],
  formatUsd: (n: number) => `$${n}`,
  BASIC_FEATURES: [],
  ROLLING_WINDOW_LIMITS: {},
  getWindowDisplays: () => ({ windows: [], overageEnabled: false }),
  getUsageLimitNotice: () => null,
  buildCloudBillingUrls: () => ({}),
}))
mock.module('../../../components/billing/SeatCounter', () => ({
  SeatCounter: () => null,
}))
mock.module('../../../components/billing/FeatureList', () => ({
  FeatureList: () => null,
}))
mock.module('../../../components/layout/sidebar/CreateWorkspaceModal', () => ({
  CreateWorkspaceModal: ({ visible }: any) => visible ? createElement('div', { 'data-testid': 'modal' }) : null,
}))
mock.module('../../../lib/open-external-link', () => ({ openExternalLink: () => {} }))
mock.module('mobx-react-lite', () => ({ observer: (c: any) => c }))

// ── Key mock: usePooledWorkspaceCreation ─────────────────────────────────────

const basicParentWithRoom = {
  id: 'ws-basic',
  name: 'Acme',
  parentWorkspaceId: null,
}

const basicParentAtCap = {
  id: 'ws-basic-cap',
  name: 'Acme Full',
  parentWorkspaceId: null,
}

let mockParent: typeof basicParentWithRoom | null = basicParentWithRoom
let mockAtCapParent: typeof basicParentAtCap | null = null
let mockPlans: Record<string, any> = {
  'ws-basic': { planId: 'basic', canManageChildren: true, includedWorkspaces: { limit: 3, used: 1 } },
}

mock.module('../../../hooks/usePooledWorkspaceCreation', () => ({
  usePooledWorkspaceCreation: () => ({
    parent: mockParent,
    atCapParent: mockAtCapParent,
    plans: mockPlans,
    createPooledWorkspace: async () => {},
  }),
}))

afterEach(() => {
  cleanup()
  mockParent = basicParentWithRoom
  mockAtCapParent = null
  mockPlans = {
    'ws-basic': { planId: 'basic', canManageChildren: true, includedWorkspaces: { limit: 3, used: 1 } },
  }
})

// ── Lazy import AFTER all mocks ──────────────────────────────────────────────

const { default: NewWorkspacePage } = await import('../new-workspace')

// ── Tests ────────────────────────────────────────────────────────────────────

describe('new-workspace included workspace card (AC10)', () => {
  test('shows used/limit line when Basic parent has room (1 of 3 used)', async () => {
    render(createElement(NewWorkspacePage))
    // The included card should show the usage label
    const usageText = screen.queryAllByText((t) => t.includes('1 of 3') || t.includes('3 workspaces'))
    expect(usageText.length).toBeGreaterThan(0)
    // The "Create included workspace" button should be present
    const btn = screen.queryAllByText((t) => t.includes('Create included workspace'))
    expect(btn.length).toBeGreaterThan(0)
  })

  test('shows upgrade card when Basic parent is at cap (3 of 3 used)', async () => {
    mockParent = null
    mockAtCapParent = basicParentAtCap
    mockPlans = {
      'ws-basic-cap': { planId: 'basic', canManageChildren: true, includedWorkspaces: { limit: 3, used: 3 } },
    }
    render(createElement(NewWorkspacePage))
    // Should NOT show "Create included workspace"
    const createBtn = screen.queryAllByText((t) => t.includes('Create included workspace'))
    expect(createBtn.length).toBe(0)
    // Should show limit reached messaging
    const limitText = screen.queryAllByText((t) =>
      t.includes('workspace limit reached') || t.includes('3 of 3') || t.includes('Upgrade'),
    )
    expect(limitText.length).toBeGreaterThan(0)
  })

  test('shows unlimited label for Business plan parent', async () => {
    mockParent = { id: 'ws-biz', name: 'BigCo', parentWorkspaceId: null }
    mockAtCapParent = null
    mockPlans = {
      'ws-biz': { planId: 'business', canManageChildren: true, includedWorkspaces: { limit: null, used: 5 } },
    }
    render(createElement(NewWorkspacePage))
    const unlimitedText = screen.queryAllByText((t) => t.includes('unlimited workspaces'))
    expect(unlimitedText.length).toBeGreaterThan(0)
  })
})
