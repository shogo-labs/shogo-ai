// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SetSpendLimitDialog
 *
 * Modal that lets a workspace owner cap on-demand / overage spend per month.
 * Wraps `api.setUsageBasedPricing`. Used from the workspace Usage tab's
 * "Set Limit" CTA on the On-Demand progress card and from the Billing tab.
 */

import { useEffect, useState } from 'react'
import { Modal, Platform, Pressable, View, Text } from 'react-native'
import { X } from 'lucide-react-native'
import { Button, Input, cn } from '@shogo/shared-ui/primitives'
import { api } from '../../lib/api'
import { useDomainHttp } from '../../contexts/domain'

interface SetSpendLimitDialogProps {
  visible: boolean
  onClose: () => void
  workspaceId: string | undefined
  /** Current cap (USD) or null when no cap is set. */
  currentLimitUsd: number | null
  /** Optional accumulated overage so far this period (purely informational). */
  accumulatedUsageUsd?: number
  onSaved?: () => void
}

export function SetSpendLimitDialog({
  visible,
  onClose,
  workspaceId,
  currentLimitUsd,
  accumulatedUsageUsd,
  onSaved,
}: SetSpendLimitDialogProps) {
  const http = useDomainHttp()
  const [input, setInput] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (visible) {
      setInput(currentLimitUsd != null ? String(currentLimitUsd) : '')
      setError(null)
    }
  }, [visible, currentLimitUsd])

  const handleSave = async () => {
    if (!workspaceId) return
    setSaving(true)
    setError(null)
    try {
      const trimmed = input.trim()
      let limitUsd: number | null = null
      if (trimmed !== '') {
        const parsed = Number(trimmed)
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error('Enter a non-negative number')
        }
        limitUsd = parsed
      }
      await api.setUsageBasedPricing(http, workspaceId, {
        enabled: true,
        hardLimitUsd: limitUsd,
      })
      onSaved?.()
      onClose()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to update spending cap')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType={Platform.OS === 'web' ? 'fade' : 'slide'}
      onRequestClose={onClose}
    >
      <Pressable
        className="flex-1 bg-black/60 items-center justify-center p-4"
        onPress={onClose}
      >
        <Pressable
          onPress={(e) => e.stopPropagation?.()}
          className={cn(
            'w-full max-w-md bg-card rounded-xl border border-border',
          )}
        >
          <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
            <Text className="text-base font-semibold text-foreground">
              Set spending limit
            </Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <X size={18} className="text-muted-foreground" />
            </Pressable>
          </View>

          <View className="p-4 gap-3">
            <Text className="text-sm text-muted-foreground">
              You keep working when included usage runs out — we charge the saved card
              in trust blocks billed at provider cost + 20%. Blocks start at $100 and
              step up by $100 as you build payment history (capped at $500 per charge).
            </Text>

            <View className="gap-1">
              <Text className="text-xs text-muted-foreground">
                Monthly spending cap (USD)
              </Text>
              <Input
                value={input}
                onChangeText={setInput}
                keyboardType="decimal-pad"
                placeholder="e.g. 100"
              />
              <Text className="text-[11px] text-muted-foreground">
                Leave blank for no cap. Set to 0 to stop overage entirely once
                included usage runs out.
              </Text>
            </View>

            {accumulatedUsageUsd != null && accumulatedUsageUsd > 0 && (
              <Text className="text-xs text-muted-foreground">
                Overage this period: ${accumulatedUsageUsd.toFixed(2)}
              </Text>
            )}

            {error && (
              <Text className="text-xs text-destructive">{error}</Text>
            )}
          </View>

          <View className="flex-row items-center justify-end gap-2 px-4 py-3 border-t border-border">
            <Button variant="outline" onPress={onClose} disabled={saving}>
              <Text className="text-foreground font-medium text-sm">Cancel</Text>
            </Button>
            <Button onPress={handleSave} disabled={saving || !workspaceId}>
              <Text className="text-primary-foreground font-medium text-sm">
                {saving ? 'Saving…' : 'Save limit'}
              </Text>
            </Button>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}
