// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PaymentIssueBanner — the one thing that outranks the plan summary (SHO-451).
 *
 * Two different problems, one place at the top of the page:
 * - `subscription_past_due`: the last charge failed. The card has to be updated
 *   before the grace period runs out, so the action is the Stripe portal.
 * - `overage_unpaid`: an on-demand usage block is invoiced but unpaid, which
 *   pauses overage. The action is the hosted invoice, where the customer can
 *   also confirm a bank-required authentication.
 *
 * This used to be a red box inside the usage card, where it was easy to miss.
 */
import { View, Text } from 'react-native'
import { AlertTriangle } from 'lucide-react-native'
import { Button } from '@shogo/shared-ui/primitives'
import type { BillingSummaryPastDue } from '@shogo/shared-app/hooks'
import { formatUsd } from '../../lib/billing-config'

export function PaymentIssueBanner({
  pastDue,
  isIos,
  isBusy,
  onUpdateCard,
  onPayInvoice,
}: {
  pastDue: BillingSummaryPastDue | null | undefined
  isIos: boolean
  isBusy?: boolean
  onUpdateCard: () => void
  onPayInvoice: (url: string) => void
}) {
  if (!pastDue) return null

  const isSubscription = pastDue.reason === 'subscription_past_due'
  const message = isSubscription
    ? 'Your last payment failed. Update your card to keep paid features.'
    : `On-demand usage is paused until this ${formatUsd(pastDue.amountUsd)} invoice is paid.`

  return (
    <View
      className="mb-4 flex-row items-start gap-3 rounded-2xl border border-destructive/40 bg-destructive/10 p-4"
      testID="billing-payment-banner"
    >
      <AlertTriangle size={18} className="mt-0.5 text-destructive" />
      <View className="flex-1 gap-2">
        <Text className="text-sm font-medium text-foreground">{message}</Text>
        {isSubscription ? (
          <Button size="sm" onPress={onUpdateCard} disabled={isBusy} testID="billing-update-card">
            {isBusy ? 'Opening…' : 'Update card'}
          </Button>
        ) : pastDue.invoiceUrl && !isIos ? (
          <Button
            size="sm"
            onPress={() => onPayInvoice(pastDue.invoiceUrl!)}
            testID="billing-pay-invoice"
          >
            Pay invoice
          </Button>
        ) : null}
      </View>
    </View>
  )
}
