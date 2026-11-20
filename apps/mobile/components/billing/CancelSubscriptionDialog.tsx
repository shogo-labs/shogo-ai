// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CancelSubscriptionDialog — self-serve cancel, with the cheaper option first
 * (SHO-451).
 *
 * Cancelling is a real decision, so the dialog says exactly what happens: you
 * keep access until the end of the period you already paid for, your projects
 * and data stay, and agents/seats drop to Free limits afterwards. A Business
 * workspace is offered "Switch to Basic" before "Cancel at period end" — the
 * downgrade is usually what the person actually wants.
 *
 * Once a cancellation is scheduled the same dialog becomes the place to undo
 * it, so there is one surface for both directions.
 */
import { useCallback, useState } from 'react'
import { Modal, Platform, Pressable, View } from 'react-native'
import { X as XIcon } from 'lucide-react-native'
import { Button, cn } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../contexts/domain'
import { api } from '../../lib/api'
import { getPlanDisplayName } from '../../lib/billing-config'
import { Text, accountSheetIcon } from '../settings/account-sheet-chrome'

const X = accountSheetIcon(XIcon)

function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function CancelSubscriptionDialog({
  visible,
  onClose,
  workspaceId,
  planId,
  currentPeriodEnd,
  cancelAtPeriodEnd,
  localMode = false,
  onSwitchToBasic,
  onChanged,
}: {
  visible: boolean
  onClose: () => void
  workspaceId: string | undefined
  planId?: string
  currentPeriodEnd?: string | null
  cancelAtPeriodEnd: boolean
  localMode?: boolean
  /** Business only: open the plan-change dialog for Basic instead. */
  onSwitchToBasic?: () => void
  onChanged?: (action: 'cancel' | 'resume') => void
}) {
  const http = useDomainHttp()
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(
    async (action: 'cancel' | 'resume') => {
      if (!workspaceId) return
      setIsBusy(true)
      setError(null)
      try {
        const result =
          action === 'cancel'
            ? await api.cancelSubscription(http, workspaceId, localMode)
            : await api.resumeSubscription(http, workspaceId, localMode)
        if (!result || (result as any).error) {
          setError((result as any)?.error?.message ?? 'Could not update the subscription.')
          return
        }
        onChanged?.(action)
        onClose()
      } catch (err: any) {
        setError(err?.details?.error?.message ?? err?.message ?? 'Could not update the subscription.')
      } finally {
        setIsBusy(false)
      }
    },
    [http, workspaceId, localMode, onChanged, onClose],
  )

  const isBusiness = (planId ?? '').toLowerCase().startsWith('business')
  const endsOn = formatDate(currentPeriodEnd)

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
          testID="cancel-subscription-dialog"
        >
          <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
            <Text className="text-base font-semibold text-foreground">
              {cancelAtPeriodEnd ? 'Resume subscription' : 'Cancel subscription'}
            </Text>
            <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Close">
              <X size={18} className="text-muted-foreground" />
            </Pressable>
          </View>

          <View className="p-4 gap-3">
            {cancelAtPeriodEnd ? (
              <Text className="text-sm text-muted-foreground">
                Your {getPlanDisplayName(planId)} plan is cancelled and ends
                {endsOn ? ` on ${endsOn}` : ' at the end of this period'}. You keep everything until
                then. Resume to keep the plan renewing.
              </Text>
            ) : (
              <View className="gap-2">
                <Text className="text-sm text-muted-foreground">
                  You keep access to your {getPlanDisplayName(planId)} plan
                  {endsOn ? ` until ${endsOn}` : ' until the end of this period'}. Your projects and
                  data stay. After that the workspace drops to Free limits: agents and seats are
                  reduced, and usage is capped by the Free windows.
                </Text>
                {isBusiness && onSwitchToBasic ? (
                  <Text className="text-sm text-muted-foreground">
                    Want to keep a paid plan for less? Switch to Basic instead.
                  </Text>
                ) : null}
              </View>
            )}

            {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
          </View>

          <View className="flex-row flex-wrap items-center justify-end gap-2 px-4 py-3 border-t border-border">
            <Button variant="outline" onPress={onClose} disabled={isBusy}>
              <Text className="text-foreground font-medium text-sm">
                {cancelAtPeriodEnd ? 'Keep cancelled' : 'Keep my plan'}
              </Text>
            </Button>
            {!cancelAtPeriodEnd && isBusiness && onSwitchToBasic ? (
              <Button
                variant="outline"
                onPress={() => {
                  onClose()
                  onSwitchToBasic()
                }}
                disabled={isBusy}
                testID="cancel-switch-to-basic"
              >
                <Text className="text-foreground font-medium text-sm">Switch to Basic</Text>
              </Button>
            ) : null}
            <Button
              onPress={() => run(cancelAtPeriodEnd ? 'resume' : 'cancel')}
              disabled={isBusy}
              testID={cancelAtPeriodEnd ? 'resume-subscription' : 'confirm-cancel-subscription'}
            >
              <Text className="text-primary-foreground font-medium text-sm">
                {isBusy
                  ? 'Saving…'
                  : cancelAtPeriodEnd
                    ? 'Resume subscription'
                    : 'Cancel at period end'}
              </Text>
            </Button>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}
