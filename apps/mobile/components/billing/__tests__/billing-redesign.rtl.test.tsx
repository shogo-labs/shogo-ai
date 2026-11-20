// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-451 — the billing page's new surfaces render what the API sends.
 *
 * These are the pieces the redesign added: the summary card (plan, seats,
 * price, renewal, next invoice, card), the payment-issue banner that outranks
 * everything else, the compact plan comparison a paying workspace gets instead
 * of three sales cards, and the two dialogs that change or end a subscription.
 *
 * The regression they guard: "Change Plan" used to open a second Stripe
 * Checkout, which created a second subscription while the first kept billing.
 * The dialog here must call `previewPlanChange` then `changePlan` with the
 * preview's own `prorationDate` — never a checkout.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    Pressable: ({ testID, children, onPress, disabled, accessibilityLabel }: any) =>
      createElement(
        'button',
        {
          'data-testid': testID,
          'aria-label': accessibilityLabel,
          'aria-disabled': disabled || undefined,
          onClick: disabled ? undefined : onPress,
        },
        children,
      ),
    View: ({ testID, children }: any) => createElement('div', { 'data-testid': testID }, children),
    Modal: ({ visible, children }: any) =>
      visible ? createElement('div', { 'data-testid': 'modal' }, children) : null,
  } as any),
)

const passthrough = ({ children }: any) => createElement('div', null, children)
mock.module('@shogo/shared-ui/primitives', () => ({
  Badge: passthrough,
  Card: passthrough,
  CardContent: passthrough,
  Button: ({ children, onPress, testID, disabled }: any) =>
    createElement(
      'button',
      { 'data-testid': testID, 'aria-disabled': disabled || undefined, onClick: disabled ? undefined : onPress },
      children,
    ),
  cn: (...a: unknown[]) => a.filter(Boolean).join(' '),
}))
mock.module('../../settings/account-sheet-chrome', () => ({
  Text: ({ children, testID }: any) => createElement('span', { 'data-testid': testID }, children),
  accountSheetIcon: () => () => null,
}))

const http = {}
mock.module('../../../contexts/domain', () => ({ useDomainHttp: () => http }))

const previewCalls: any[] = []
const applyCalls: any[] = []
const cancelCalls: any[] = []
const resumeCalls: any[] = []
let previewResult: any = null
let applyResult: any = null
let cancelResult: any = null
let resumeResult: any = null

mock.module('../../../lib/api', () => ({
  api: {
    previewPlanChange: async (_http: any, params: any) => {
      previewCalls.push(params)
      return previewResult
    },
    changePlan: async (_http: any, params: any) => {
      applyCalls.push(params)
      return applyResult
    },
    cancelSubscription: async (_http: any, workspaceId: string) => {
      cancelCalls.push(workspaceId)
      return cancelResult
    },
    resumeSubscription: async (_http: any, workspaceId: string) => {
      resumeCalls.push(workspaceId)
      return resumeResult
    },
  },
}))

const { BillingSummaryCard, summaryPriceUsd } = await import('../BillingSummaryCard')
const { PaymentIssueBanner } = await import('../PaymentIssueBanner')
const { PlanComparison } = await import('../PlanComparison')
const { PlanChangeDialog } = await import('../PlanChangeDialog')
const { CancelSubscriptionDialog } = await import('../CancelSubscriptionDialog')

const noop = () => {}

function summary(over: Record<string, unknown> = {}) {
  return {
    planId: 'business',
    planSource: 'subscription' as const,
    status: 'active',
    seats: 3,
    billingInterval: 'monthly' as const,
    currentPeriodEnd: '2026-04-01T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    trialEndsAt: null,
    nextInvoice: { amountUsd: 297, currency: 'USD', date: '2026-04-01T00:00:00.000Z' },
    paymentMethod: { brand: 'visa', last4: '4242', expMonth: 4, expYear: 2030 },
    pastDue: null,
    ...over,
  } as any
}

beforeEach(() => {
  previewCalls.length = 0
  applyCalls.length = 0
  cancelCalls.length = 0
  resumeCalls.length = 0
  previewResult = {
    planId: 'business',
    billingInterval: 'monthly',
    seats: 3,
    currentPriceUsd: 87,
    newPriceUsd: 297,
    prorationUsd: 210,
    effectiveAt: '2026-03-15T12:00:00.000Z',
    nextInvoiceUsd: 297,
    prorationDate: 1_773_000_000,
  }
  applyResult = { ok: true, planId: 'business', seats: 3, billingInterval: 'monthly', status: 'active' }
  cancelResult = { ok: true, cancelAtPeriodEnd: true, accessEndsAt: '2026-04-01T00:00:00.000Z' }
  resumeResult = { ok: true, cancelAtPeriodEnd: false, accessEndsAt: '2026-04-01T00:00:00.000Z' }
})

afterEach(() => cleanup())

// ============================================================================
// BillingSummaryCard
// ============================================================================

describe('BillingSummaryCard', () => {
  test('answers plan, seats, price, renewal, next invoice and card', () => {
    render(
      createElement(BillingSummaryCard, {
        summary: summary(),
        workspaceName: 'Acme',
        isIos: false,
        onManage: noop,
        onChangePlan: noop,
        onRestore: noop,
      }),
    )

    expect(screen.getByText("You're on Business Plan")).toBeTruthy()
    expect(screen.getByTestId('billing-summary-seats').textContent).toContain('3')
    // 3 seats × $16/mo — the same number the plan cards below show.
    expect(screen.getByTestId('billing-summary-price').textContent).toContain('$48')
    expect(screen.getByTestId('billing-summary-price').textContent).toContain('per month')
    expect(screen.getByTestId('billing-summary-renewal').textContent).toContain('Renews')
    expect(screen.getByTestId('billing-summary-next-invoice').textContent).toContain('$297')
    expect(screen.getByTestId('billing-summary-card').textContent).toContain('Visa ••4242')
  })

  test('a scheduled cancellation reads as an end date, not a renewal', () => {
    render(
      createElement(BillingSummaryCard, {
        summary: summary({ cancelAtPeriodEnd: true }),
        isIos: false,
        onManage: noop,
        onChangePlan: noop,
        onRestore: noop,
      }),
    )

    const renewal = screen.getByTestId('billing-summary-renewal')
    expect(renewal.textContent).toContain('Access ends')
    expect(renewal.textContent).toContain('Ends on')
  })

  test('a trial shows its end date and a Free trial subtitle', () => {
    render(
      createElement(BillingSummaryCard, {
        summary: summary({ status: 'trialing', trialEndsAt: '2026-03-22T00:00:00.000Z' }),
        isIos: false,
        onManage: noop,
        onChangePlan: noop,
        onRestore: noop,
      }),
    )

    expect(screen.getByText('Free trial')).toBeTruthy()
    expect(screen.getByTestId('billing-summary-renewal').textContent).toContain('Trial ends')
  })

  test('a past-due subscription is labelled, not hidden', () => {
    render(
      createElement(BillingSummaryCard, {
        summary: summary({ status: 'past_due' }),
        isIos: false,
        onManage: noop,
        onChangePlan: noop,
        onRestore: noop,
      }),
    )

    expect(screen.getByText('Payment failed')).toBeTruthy()
    expect(screen.getByText('Past due')).toBeTruthy()
  })

  test('a grant-conferred plan offers no Manage or Change plan', () => {
    render(
      createElement(BillingSummaryCard, {
        summary: summary({ planSource: 'grant', nextInvoice: null, paymentMethod: null }),
        isIos: false,
        onManage: noop,
        onChangePlan: noop,
        onRestore: noop,
      }),
    )

    expect(screen.getByText('Granted by a license key')).toBeTruthy()
    expect(screen.queryByTestId('billing-change-plan')).toBeNull()
    expect(screen.queryByTestId('billing-summary-card')).toBeNull()
  })

  test('iOS gets Restore Purchases and no web plan controls', () => {
    render(
      createElement(BillingSummaryCard, {
        summary: summary(),
        isIos: true,
        onManage: noop,
        onChangePlan: noop,
        onRestore: noop,
      }),
    )

    expect(screen.getByText('Restore Purchases')).toBeTruthy()
    expect(screen.queryByTestId('billing-change-plan')).toBeNull()
  })

  test('a free workspace still renders, with no price line', () => {
    render(
      createElement(BillingSummaryCard, {
        summary: summary({
          planId: 'free',
          planSource: 'free',
          status: null,
          seats: 1,
          billingInterval: null,
          currentPeriodEnd: null,
          nextInvoice: null,
          paymentMethod: null,
        }),
        isIos: false,
        onManage: noop,
        onChangePlan: noop,
        onRestore: noop,
      }),
    )

    expect(screen.getByText("You're on Free Plan")).toBeTruthy()
    expect(screen.queryByTestId('billing-summary-price')).toBeNull()
    expect(screen.getByTestId('billing-summary-renewal').textContent).toContain(
      'No renewal scheduled',
    )
  })

  test('summaryPriceUsd multiplies per-seat plans and not Basic', () => {
    expect(summaryPriceUsd(summary({ planId: 'business', seats: 3 }))).toBe(48)
    expect(summaryPriceUsd(summary({ planId: 'basic', seats: 3 }))).toBe(8)
    expect(summaryPriceUsd(summary({ planId: 'business', seats: 2, billingInterval: 'annual' }))).toBe(
      312,
    )
  })
})

// ============================================================================
// PaymentIssueBanner
// ============================================================================

describe('PaymentIssueBanner', () => {
  test('renders nothing when there is no problem', () => {
    const { container } = render(
      createElement(PaymentIssueBanner, {
        pastDue: null,
        isIos: false,
        onUpdateCard: noop,
        onPayInvoice: noop,
      }),
    )
    expect(container.textContent).toBe('')
  })

  test('a failed charge points at the card, not the invoice', () => {
    render(
      createElement(PaymentIssueBanner, {
        pastDue: { reason: 'subscription_past_due', amountUsd: 87, invoiceUrl: null },
        isIos: false,
        onUpdateCard: noop,
        onPayInvoice: noop,
      }),
    )

    expect(screen.getByText(/Your last payment failed/)).toBeTruthy()
    expect(screen.getByTestId('billing-update-card')).toBeTruthy()
    expect(screen.queryByTestId('billing-pay-invoice')).toBeNull()
  })

  test('an unpaid overage invoice shows the amount and a pay link', () => {
    const paid: string[] = []
    render(
      createElement(PaymentIssueBanner, {
        pastDue: {
          reason: 'overage_unpaid',
          amountUsd: 12.5,
          invoiceUrl: 'https://invoice.stripe.com/i/2',
        },
        isIos: false,
        onUpdateCard: noop,
        onPayInvoice: (url: string) => paid.push(url),
      }),
    )

    expect(screen.getByText(/\$12\.50 invoice is paid/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('billing-pay-invoice'))
    expect(paid).toEqual(['https://invoice.stripe.com/i/2'])
  })

  test('iOS never offers the web invoice link', () => {
    render(
      createElement(PaymentIssueBanner, {
        pastDue: {
          reason: 'overage_unpaid',
          amountUsd: 12.5,
          invoiceUrl: 'https://invoice.stripe.com/i/2',
        },
        isIos: true,
        onUpdateCard: noop,
        onPayInvoice: noop,
      }),
    )

    expect(screen.queryByTestId('billing-pay-invoice')).toBeNull()
  })
})

// ============================================================================
// PlanComparison
// ============================================================================

describe('PlanComparison', () => {
  test('marks the current plan and offers the other tier', () => {
    const selected: string[] = []
    render(
      createElement(PlanComparison, {
        currentPlanId: 'business',
        billingInterval: 'monthly',
        seats: 3,
        isIos: false,
        onSelect: (planId: string) => selected.push(planId),
        onContactSales: noop,
      }),
    )

    expect(screen.getByTestId('plan-row-business').textContent).toContain('Current plan')
    expect(screen.getByTestId('plan-row-business').textContent).toContain('Active')
    expect(screen.getByTestId('plan-row-basic').textContent).not.toContain('Current plan')

    fireEvent.click(screen.getByText('Switch to Basic'))
    expect(selected).toEqual(['basic'])
  })

  test('a retired Pro plan is shown as the current Business plan', () => {
    render(
      createElement(PlanComparison, {
        currentPlanId: 'pro',
        billingInterval: 'monthly',
        seats: 2,
        isIos: false,
        onSelect: noop,
        onContactSales: noop,
      }),
    )

    expect(screen.getByTestId('plan-row-business').textContent).toContain('Current plan')
  })

  test('prices the per-seat tier by seat count', () => {
    render(
      createElement(PlanComparison, {
        currentPlanId: 'basic',
        billingInterval: 'monthly',
        seats: 4,
        isIos: false,
        onSelect: noop,
        onContactSales: noop,
      }),
    )

    expect(screen.getByTestId('plan-row-business').textContent).toContain('$64')
    expect(screen.getByTestId('plan-row-business').textContent).toContain('4 seats')
  })

  test('iOS hides the Enterprise row', () => {
    render(
      createElement(PlanComparison, {
        currentPlanId: 'basic',
        billingInterval: 'monthly',
        seats: 1,
        isIos: true,
        onSelect: noop,
        onContactSales: noop,
      }),
    )

    expect(screen.queryByText('Book a demo')).toBeNull()
  })
})

// ============================================================================
// PlanChangeDialog — the second-Checkout regression
// ============================================================================

describe('PlanChangeDialog', () => {
  test('prices the change first, then applies it with the previewed proration date', async () => {
    const applied: any[] = []
    render(
      createElement(PlanChangeDialog, {
        visible: true,
        onClose: noop,
        workspaceId: 'w1',
        currentPlanId: 'basic',
        target: { planId: 'business', billingInterval: 'monthly', seats: 3 },
        onApplied: (r: any) => applied.push(r),
      }),
    )

    await waitFor(() => expect(previewCalls).toHaveLength(1))
    expect(previewCalls[0]).toMatchObject({
      workspaceId: 'w1',
      planId: 'business',
      billingInterval: 'monthly',
      seats: 3,
    })

    await waitFor(() => expect(screen.getByTestId('plan-change-proration')).toBeTruthy())
    expect(screen.getByTestId('plan-change-proration').textContent).toContain('$210')
    expect(screen.getByText('Change to Business Plan')).toBeTruthy()

    fireEvent.click(screen.getByTestId('plan-change-confirm'))

    await waitFor(() => expect(applyCalls).toHaveLength(1))
    // The charge must match what was shown: same prorationDate, no checkout.
    expect(applyCalls[0]).toMatchObject({
      workspaceId: 'w1',
      planId: 'business',
      billingInterval: 'monthly',
      seats: 3,
      prorationDate: 1_773_000_000,
    })
    await waitFor(() => expect(applied).toHaveLength(1))
    expect(applied[0]).toMatchObject({ planId: 'business', seats: 3 })
  })

  test('shows the server message when the preview is refused', async () => {
    previewResult = { error: { code: 'no_subscription', message: 'This workspace has no subscription to change.' } }

    render(
      createElement(PlanChangeDialog, {
        visible: true,
        onClose: noop,
        workspaceId: 'w1',
        target: { planId: 'business', billingInterval: 'monthly', seats: 1 },
      }),
    )

    await waitFor(() =>
      expect(screen.getByText('This workspace has no subscription to change.')).toBeTruthy(),
    )
    // Nothing to confirm, so the button stays disabled.
    expect(screen.getByTestId('plan-change-confirm').getAttribute('aria-disabled')).toBe('true')
  })

  test('shows the server message when the apply is refused', async () => {
    applyResult = { error: { code: 'subscription_inactive', message: 'This subscription is canceled.' } }

    render(
      createElement(PlanChangeDialog, {
        visible: true,
        onClose: noop,
        workspaceId: 'w1',
        target: { planId: 'business', billingInterval: 'monthly', seats: 1 },
      }),
    )

    await waitFor(() => expect(screen.getByTestId('plan-change-confirm')).toBeTruthy())
    fireEvent.click(screen.getByTestId('plan-change-confirm'))

    await waitFor(() => expect(screen.getByText('This subscription is canceled.')).toBeTruthy())
  })

  test('does not price anything while closed', () => {
    render(
      createElement(PlanChangeDialog, {
        visible: false,
        onClose: noop,
        workspaceId: 'w1',
        target: { planId: 'business', billingInterval: 'monthly', seats: 1 },
      }),
    )

    expect(previewCalls).toHaveLength(0)
  })
})

// ============================================================================
// CancelSubscriptionDialog
// ============================================================================

describe('CancelSubscriptionDialog', () => {
  test('says what happens to access, data and limits before cancelling', () => {
    render(
      createElement(CancelSubscriptionDialog, {
        visible: true,
        onClose: noop,
        workspaceId: 'w1',
        planId: 'business',
        currentPeriodEnd: '2026-04-01T00:00:00.000Z',
        cancelAtPeriodEnd: false,
      }),
    )

    expect(screen.getByText('Cancel subscription')).toBeTruthy()
    expect(screen.getByText(/You keep access to your Business plan/)).toBeTruthy()
    expect(screen.getByText(/drops to Free limits/)).toBeTruthy()
    expect(screen.getByTestId('confirm-cancel-subscription')).toBeTruthy()
  })

  test('cancels at period end and reports the change', async () => {
    const changed: string[] = []
    render(
      createElement(CancelSubscriptionDialog, {
        visible: true,
        onClose: noop,
        workspaceId: 'w1',
        planId: 'business',
        currentPeriodEnd: '2026-04-01T00:00:00.000Z',
        cancelAtPeriodEnd: false,
        onChanged: (action: string) => changed.push(action),
      }),
    )

    fireEvent.click(screen.getByTestId('confirm-cancel-subscription'))

    await waitFor(() => expect(cancelCalls).toEqual(['w1']))
    await waitFor(() => expect(changed).toEqual(['cancel']))
  })

  test('offers the cheaper downgrade before cancelling a Business plan', () => {
    const switched: string[] = []
    render(
      createElement(CancelSubscriptionDialog, {
        visible: true,
        onClose: noop,
        workspaceId: 'w1',
        planId: 'business',
        currentPeriodEnd: '2026-04-01T00:00:00.000Z',
        cancelAtPeriodEnd: false,
        onSwitchToBasic: () => switched.push('basic'),
      }),
    )

    expect(screen.getByText(/Switch to Basic instead/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('cancel-switch-to-basic'))
    expect(switched).toEqual(['basic'])
  })

  test('a Basic plan is not offered a downgrade to itself', () => {
    render(
      createElement(CancelSubscriptionDialog, {
        visible: true,
        onClose: noop,
        workspaceId: 'w1',
        planId: 'basic',
        currentPeriodEnd: '2026-04-01T00:00:00.000Z',
        cancelAtPeriodEnd: false,
        onSwitchToBasic: noop,
      }),
    )

    expect(screen.queryByTestId('cancel-switch-to-basic')).toBeNull()
  })

  test('becomes the place to resume a scheduled cancellation', async () => {
    const changed: string[] = []
    render(
      createElement(CancelSubscriptionDialog, {
        visible: true,
        onClose: noop,
        workspaceId: 'w1',
        planId: 'business',
        currentPeriodEnd: '2026-04-01T00:00:00.000Z',
        cancelAtPeriodEnd: true,
        onChanged: (action: string) => changed.push(action),
      }),
    )

    expect(screen.getByTestId('resume-subscription')).toBeTruthy()
    fireEvent.click(screen.getByTestId('resume-subscription'))

    await waitFor(() => expect(resumeCalls).toEqual(['w1']))
    await waitFor(() => expect(changed).toEqual(['resume']))
  })

  test('shows the server message when the cancel is refused', async () => {
    cancelResult = { error: { code: 'no_subscription', message: 'This workspace has no subscription.' } }

    render(
      createElement(CancelSubscriptionDialog, {
        visible: true,
        onClose: noop,
        workspaceId: 'w1',
        planId: 'business',
        cancelAtPeriodEnd: false,
      }),
    )

    fireEvent.click(screen.getByTestId('confirm-cancel-subscription'))
    await waitFor(() =>
      expect(screen.getByText('This workspace has no subscription.')).toBeTruthy(),
    )
  })
})
