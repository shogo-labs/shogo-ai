// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Settings → Chat → Agent replies: how many agents may work at once, and where
 * that number comes from (the plan, or the desktop default). An admin steps it
 * down when the workspace is getting more tags than it can usefully run;
 * lowering it is always allowed, raising it past the plan is not.
 */
import { Platform, Pressable, View } from 'react-native'
import { Minus, Plus } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Text } from '../settings/account-sheet-chrome'
import { useAgentCapacity } from '../../hooks/useAgentCapacity'

const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  starter: 'Starter',
  pro: 'Pro',
  business: 'Business',
  enterprise: 'Enterprise',
}

function StepperButton({
  label,
  onPress,
  disabled,
  testID,
  children,
}: {
  label: string
  onPress: () => void
  disabled: boolean
  testID: string
  children: React.ReactNode
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      className={cn(
        'h-7 w-7 items-center justify-center rounded-md border border-border',
        disabled ? 'opacity-40' : 'active:bg-accent/50 web:hover:bg-accent/40',
      )}
    >
      {children}
    </Pressable>
  )
}

export function AgentCapacityCard({ workspaceId }: { workspaceId: string }) {
  const { capacity, error, saving, setConcurrency } = useAgentCapacity(workspaceId)

  if (!capacity) {
    return (
      <Text testID="agent-capacity-card" className="text-xs text-muted-foreground">
        {error ?? 'Checking how many agents can work at once…'}
      </Text>
    )
  }

  const { limit, max, defaultLimit, configured, source, planId, running, queued, canManage } = capacity
  const planLabel = PLAN_LABELS[planId] ?? planId
  const busy = saving || !canManage
  const origin =
    source === 'local'
      ? `Desktop default is ${defaultLimit}. You can choose 1 to ${max}.`
      : `Your ${planLabel} plan allows up to ${max}.`

  return (
    <View testID="agent-capacity-card">
      <View className="flex-row items-center gap-3">
        <View className="flex-1">
          <Text className="text-sm text-foreground">Agents working at once</Text>
          <Text className="mt-0.5 text-xs text-muted-foreground">
            {running} working
            {queued > 0 ? ` · ${queued} waiting for a slot` : ''}
          </Text>
        </View>
        {canManage ? (
          <View className="flex-row items-center gap-2">
            <StepperButton
              label="Fewer agents at once"
              testID="agent-capacity-decrease"
              disabled={busy || limit <= 1}
              onPress={() => void setConcurrency(limit - 1)}
            >
              <Minus size={14} className="text-foreground" />
            </StepperButton>
            <Text testID="agent-capacity-value" className="min-w-8 text-center text-sm font-medium text-foreground">
              {limit}
            </Text>
            <StepperButton
              label="More agents at once"
              testID="agent-capacity-increase"
              disabled={busy || limit >= max}
              onPress={() => void setConcurrency(limit + 1)}
            >
              <Plus size={14} className="text-foreground" />
            </StepperButton>
          </View>
        ) : (
          <Text testID="agent-capacity-value" className="text-sm font-medium text-foreground">
            {limit}
          </Text>
        )}
      </View>

      <Text className="mt-2 text-xs text-muted-foreground">{origin}</Text>
      <Text className="mt-1 text-xs text-muted-foreground">
        Lower it when the workspace gets more tags than the agents can usefully answer at once — the rest wait
        their turn instead of racing.
        {Platform.OS === 'web' && source === 'plan' ? ' A higher limit comes with a larger plan.' : ''}
      </Text>

      {canManage && configured !== null ? (
        <Pressable
          accessibilityRole="button"
          testID="agent-capacity-reset"
          onPress={() => void setConcurrency(null)}
          disabled={saving}
          className={cn(
            'mt-2 self-start rounded-md border border-border px-3 py-1.5',
            saving ? 'opacity-40' : 'active:bg-accent/50 web:hover:bg-accent/40',
          )}
        >
          <Text className="text-xs text-foreground">Use the default ({defaultLimit})</Text>
        </Pressable>
      ) : null}

      {saving ? <Text className="mt-2 text-xs text-muted-foreground">Saving…</Text> : null}
      {error ? (
        <Text testID="agent-capacity-error" className="mt-2 text-xs text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  )
}
