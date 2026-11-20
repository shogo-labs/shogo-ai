// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The billing page must explain a summary it could not read (SHO-451 QA round 1).
 *
 * `useBillingSummary` returns an `error` for the two cases the plan called out:
 * a desktop install with no cloud link (`cloud_not_connected`, 401 from the
 * local bridge) and a Stripe outage (`stripe_error`, 502 from the service).
 * The page used to destructure only `summary` and `refetch`, so both rendered
 * as "You're on Free Plan" with no explanation — a paying customer told they
 * are on the free tier because a request failed.
 *
 * This renders the real screen with the data hooks stubbed and asserts the
 * banner appears with the server's own message, and that the summary card is
 * suppressed rather than claiming Free.
 *
 * Run: bun test apps/mobile/app/(app)/__tests__/billing-summary-error.rtl.test.tsx
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

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
    useWindowDimensions: () => ({ width: 1024, height: 768, scale: 1, fontScale: 1 }),
  } as any),
)

const passthrough = ({ children }: any) => createElement('div', null, children)
mock.module('@shogo/shared-ui/primitives', () => ({
  Card: ({ children, testID }: any) => createElement('div', { 'data-testid': testID }, children),
  CardContent: passthrough,
  Badge: passthrough,
  Skeleton: () => createElement('div', null, null),
  Input: (props: any) => createElement('input', props),
  Separator: () => createElement('hr', null, null),
  Switch: ({ checked, onCheckedChange }: any) =>
    createElement('input', { type: 'checkbox', checked, onChange: () => onCheckedChange?.(!checked) }),
  Progress: passthrough,
  Avatar: passthrough,
  Alert: passthrough,
  AlertTitle: passthrough,
  AlertDescription: passthrough,
  Checkbox: (props: any) => createElement('input', { type: 'checkbox', ...props }),
  PressableScale: ({ children, onPress, testID }: any) =>
    createElement('button', { 'data-testid': testID, onClick: onPress }, children),
  Button: ({ children, onPress, testID, disabled }: any) =>
    createElement(
      'button',
      { 'data-testid': testID, 'aria-disabled': disabled || undefined, onClick: disabled ? undefined : onPress },
      children,
    ),
  cn: (...a: unknown[]) => a.filter(Boolean).join(' '),
}))

// ── Leaf modules the screen imports but this test does not exercise ──────────
mock.module('expo-web-browser', () => ({ openBrowserAsync: async () => ({}) }))
mock.module('expo-linking', () => ({ createURL: () => '', openURL: async () => true }))
mock.module('expo-router', () => ({
  useRouter: () => ({ push: () => {}, back: () => {}, replace: () => {} }),
  useLocalSearchParams: () => ({}),
}))
mock.module('mobx-react-lite', () => ({ observer: (c: any) => c }))
mock.module('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
mock.module('../../../contexts/auth', () => ({
  useAuth: () => ({ user: { id: 'u1' }, isLoading: false }),
}))
mock.module('../../../contexts/domain', () => ({
  useWorkspaceCollection: () => ({ all: [{ id: 'w1', name: 'Acme' }], isLoading: false }),
  useDomainHttp: () => ({}),
}))
mock.module('../../../lib/api', () => ({
  api: {
    listInvoices: async () => [],
    getRegionalPricing: async () => null,
    getSoloFounderState: async () => ({ eligible: false }),
    createSoloFounderCheckout: async () => ({}),
    createCheckoutSession: async () => ({}),
    createPortalSession: async () => ({}),
    endTrial: async () => ({}),
    setUsageBasedPricing: async () => ({}),
    redeemLicenseKey: async () => ({}),
    verifyAppleReceipt: async () => ({}),
    previewPlanChange: async () => ({}),
    changePlan: async () => ({}),
    cancelSubscription: async () => ({}),
    resumeSubscription: async () => ({}),
  },
}))
mock.module('../../../lib/stripe-checkout', () => ({
  checkoutRedirectBase: () => '',
  completeNativeCheckout: async () => ({}),
  redirectToCheckout: async () => {},
}))
mock.module('../../../lib/pending-license', () => ({ clearPendingLicenseCode: () => {} }))
mock.module('../../../lib/iap', () => ({
  purchaseSubscription: async () => ({}),
  finishPurchase: async () => ({}),
  restorePurchases: async () => ({}),
  initIapListeners: () => () => {},
  IapError: class IapError extends Error {},
  APP_STORE_SUBSCRIPTIONS_URL: 'https://apps.apple.com/account/subscriptions',
}))
mock.module('../../../lib/rewardful', () => ({ getRewardfulReferral: () => null }))
mock.module('../../../lib/native-active-shadow', () => ({ nativeActivePill: () => ({}) }))
mock.module('../../../lib/tracking', () => ({
  trackInitiateCheckout: () => {},
  trackPurchase: () => {},
  trackBillingView: () => {},
  trackPlanClick: () => {},
  trackPlanChange: () => {},
  trackCancel: () => {},
}))
mock.module('../../../lib/workspace-store', () => ({
  resolveActiveWorkspaceId: () => 'w1',
  setActiveWorkspaceId: () => {},
}))
mock.module('../../../hooks/useActiveWorkspace', () => ({
  useActiveWorkspace: () => ({ id: 'w1', name: 'Acme' }),
}))
mock.module('../../../lib/platform-config', () => ({
  usePlatformConfig: () => ({ localMode: false }),
}))
mock.module('@shogo/shared-app/chat', () => ({
  formatApiError: (e: any) => String(e?.message ?? e),
  fillErrorCodeMessage: () => '',
  ERROR_CODE_MESSAGES: {},
}))
mock.module('../../../components/billing/BillingHistory', () => ({
  BillingHistory: () => null,
}))
mock.module('../../../components/ui/toast', () => ({
  useToast: () => ({ show: () => {} }),
  Toast: passthrough,
  ToastTitle: passthrough,
  ToastDescription: passthrough,
}))
mock.module('../../../components/ui/alert-dialog', () => ({
  AlertDialog: passthrough,
  AlertDialogBackdrop: passthrough,
  AlertDialogBody: passthrough,
  AlertDialogContent: passthrough,
  AlertDialogFooter: passthrough,
  AlertDialogHeader: passthrough,
}))
mock.module('../../../components/ui/heading', () => ({ Heading: passthrough }))
mock.module('../../../components/ui/text', () => ({ Text: passthrough }))
mock.module('../../../components/ui/button', () => ({
  Button: passthrough,
  ButtonText: passthrough,
}))

// ── The two data hooks under test ───────────────────────────────────────────
let summaryState: { summary: any; isLoading: boolean; error: string | null; refetch: () => void }

mock.module('@shogo/shared-app/hooks', () => ({
  useBillingSummary: () => summaryState,
  useBillingData: () => ({
    subscription: null,
    effectiveBalance: null,
    isLoading: false,
    refetchSubscription: () => {},
    refetchUsageWallet: () => {},
    planSource: 'free',
    usageWindows: null,
    promoCredit: null,
    trialEligible: false,
    trialEndsAt: null,
    trialMaxSeats: 1,
  }),
}))

const BillingPage = (await import('../billing')).default

beforeEach(() => {
  summaryState = {
    summary: null,
    isLoading: false,
    error: null,
    refetch: () => {},
  }
})

afterEach(() => cleanup())

describe('billing page — summary error', () => {
  test('a cloud_not_connected error is shown with the server message', () => {
    summaryState.error = 'Sign in to Shogo Cloud first.'

    render(createElement(BillingPage))

    const banner = screen.getByTestId('billing-summary-error')
    expect(banner).toBeTruthy()
    expect(banner.textContent).toContain("We couldn't load your plan details.")
    expect(banner.textContent).toContain('Sign in to Shogo Cloud first.')
    expect(screen.getByTestId('billing-summary-retry')).toBeTruthy()
  })

  test('a Stripe outage is shown, not swallowed', () => {
    summaryState.error = 'stripe is down'

    render(createElement(BillingPage))

    expect(screen.getByTestId('billing-summary-error').textContent).toContain('stripe is down')
  })

  test('the summary card is suppressed so it cannot claim Free Plan', () => {
    summaryState.error = 'Sign in to Shogo Cloud first.'

    render(createElement(BillingPage))

    // The card would otherwise render "You're on Free Plan" for a workspace we
    // simply could not read.
    expect(screen.queryByTestId('billing-summary')).toBeNull()
    expect(screen.queryByText("You're on Free Plan")).toBeNull()
  })

  test('no error means no banner and the card renders', () => {
    summaryState.summary = {
      planId: 'business',
      planSource: 'subscription',
      status: 'active',
      seats: 2,
      billingInterval: 'monthly',
      currentPeriodEnd: '2026-04-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      trialEndsAt: null,
      nextInvoice: null,
      paymentMethod: null,
      pastDue: null,
    }

    render(createElement(BillingPage))

    expect(screen.queryByTestId('billing-summary-error')).toBeNull()
    expect(screen.getByTestId('billing-summary')).toBeTruthy()
    expect(screen.getByText("You're on Business Plan")).toBeTruthy()
  })
})
