// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PlanChangeDialog — change an existing subscription's plan, seats or interval
 * in place, with the price shown before anything is charged (SHO-451).
 *
 * This replaces the old path where "Change Plan" opened a second Stripe
 * Checkout: that created a second subscription, `syncFromStripe` overwrote our
 * row with it, and the original subscription kept billing. Here the preview
 * comes from `POST /api/billing/change-plan/preview` and the confirm applies it
 * with the same `prorationDate`, so the charge matches what was shown.
 *
 * A Free workspace never reaches this dialog — it has no subscription to
 * change, so it keeps Checkout.
 */
import { useCallback, useEffect, useState } from 'react'
import { Modal, Platform, Pressable, View } from 'react-native'
import { X as XIcon } from 'lucide-react-native'
import { Button, cn } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../contexts/domain'
import { api, type PlanChangePreview } from '../../lib/api'
import { formatUsd, getPlanDisplayName } from '../../lib/billing-config'
import { Text, accountSheetIcon } from '../settings/account-sheet-chrome'

const X = accountSheetIcon(XIcon)

export interface PlanChangeTarget {
  planId: 'basic' | 'business'
  billingInterval: 'monthly' | 'annual'
  seats: number
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function intervalLabel(interval: 'monthly' | 'annual' | null | undefined): string {
  return interval === 'annual' ? 'per year' : 'per month'
}

export function PlanChangeDialog({
  visible,
  onClose,
  workspaceId,
  currentPlanId,
  target,
  localMode = false,
  onApplied,
}: {
  visible: boolean
  onClose: () => void
  workspaceId: string | undefined
  currentPlanId?: string
  target: PlanChangeTarget | null
  localMode?: boolean
  onApplied?: (result: { planId: string; seats: number; billingInterval: string }) => void
}) {
  const http = useDomainHttp()
  const [preview, setPreview] = useState<PlanChangePreview | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadPreview = useCallback(async () => {
    if (!workspaceId || !target) return
    setIsLoading(true)
    setError(null)
    setPreview(null)
    try {
      const result = await api.previewPlanChange(http, {
        workspaceId,
        planId: target.planId,
        billingInterval: target.billingInterval,
        seats: target.seats,
        localMode,
      })
      if (!result || (result as any).error) {
        setError((result as any)?.error?.message ?? 'Could not price this change.')
        return
      }
      setPreview(result)
    } catch (err: any) {
      setError(err?.details?.error?.message ?? err?.message ?? 'Could not price this change.')
    } finally {
      setIsLoading(false)
    }
  }, [http, workspaceId, target?.planId, target?.billingInterval, target?.seats, localMode])

  useEffect(() => {
    if (visible) void loadPreview()
  }, [visible, loadPreview])

  const handleConfirm = useCallback(async () => {
    if (!workspaceId || !target || !preview) return
    setIsApplying(true)
    setError(null)
    try {
      const result = await api.changePlan(http, {
        workspaceId,
        planId: target.planId,
        billingInterval: target.billingInterval,
        seats: target.seats,
        prorationDate: preview.prorationDate,
        localMode,
      })
      if (!result || (result as any).error) {
        setError((result as any)?.error?.message ?? 'Could not change the plan.')
        return
      }
      onApplied?.({
        planId: result.planId,
        seats: result.seats,
        billingInterval: result.billingInterval,
      })
      onClose()
    } catch (err: any) {
      setError(err?.details?.error?.message ?? err?.message ?? 'Could not change the plan.')
    } finally {
      setIsApplying(false)
    }
  }, [http, workspaceId, target, preview, localMode, onApplied, onClose])

  const targetName = target ? `${getPlanDisplayName(target.planId)} Plan` : 'the new plan'

  return (
    <Modal
      visible={visible}
      transparent
      animationType={Platform.OS === 'web' ? 'fade' : 'slide'}
      onRequestClose={onClose}
    >
      <Pressable className="flex-1 bg-black/60 items-center justify-center p-4" onPress={onClose}>
        <Pressable
          onPress={(e) => e.stopPropagation?.()}
          className={cn('w-full max-w-md bg-card rounded-xl border border-border')}
          testID="plan-change-dialog"
        >
          <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
            <Text className="text-base font-semibold text-foreground">Change to {targetName}</Text>
            <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Close">
              <X size={18} className="text-muted-foreground" />
            </Pressable>
          </View>

          <View className="p-4 gap-3">
            {isLoading ? (
              <Text className="text-sm text-muted-foreground">Working out the price…</Text>
            ) : preview ? (
              <View className="gap-2">
                <View className="flex-row items-center justify-between">
                  <Text className="text-sm text-muted-foreground">Today</Text>
                  <Text className="text-sm font-medium text-foreground">
                    {formatUsd(preview.currentPriceUsd)} {intervalLabel(preview.billingInterval)}
                    {preview.seats > 1 ? ` · ${preview.seats} seats` : ''}
                  </Text>
                </View>
                <View className="flex-row items-center justify-between">
                  <Text className="text-sm text-muted-foreground">After the change</Text>
                  <Text className="text-sm font-semibold text-foreground">
                    {formatUsd(preview.newPriceUsd)} {intervalLabel(preview.billingInterval)}
                  </Text>
                </View>
                <View className="flex-row items-center justify-between">
                  <Text className="text-sm text-muted-foreground">Charged today</Text>
                  <Text className="text-sm font-medium text-foreground" testID="plan-change-proration">
                    {formatUsd(preview.prorationUsd)}
                  </Text>
                </View>
                <View className="flex-row items-center justify-between">
                  <Text className="text-sm text-muted-foreground">Takes effect</Text>
                  <Text className="text-sm text-foreground">{formatDate(preview.effectiveAt)}</Text>
                </View>
                <View className="flex-row items-center justify-between">
                  <Text className="text-sm text-muted-foreground">Next invoice</Text>
                  <Text className="text-sm text-foreground">
                    {formatUsd(preview.nextInvoiceUsd)}
                  </Text>
                </View>
                <Text className="text-xs text-muted-foreground">
                  The charge today is the prorated difference for the rest of this billing period.
                  {currentPlanId && currentPlanId !== preview.planId
                    ? ` Your ${getPlanDisplayName(currentPlanId)} plan is replaced immediately.`
                    : ''}
                </Text>
              </View>
            ) : null}

            {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
          </View>

          <View className="flex-row items-center justify-end gap-2 px-4 py-3 border-t border-border">
            <Button variant="outline" onPress={onClose} disabled={isApplying}>
              <Text className="text-foreground font-medium text-sm">Cancel</Text>
            </Button>
            <Button
              onPress={handleConfirm}
              disabled={isApplying || isLoading || !preview}
              testID="plan-change-confirm"
            >
              <Text className="text-primary-foreground font-medium text-sm">
                {isApplying ? 'Changing…' : 'Confirm change'}
              </Text>
            </Button>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}
