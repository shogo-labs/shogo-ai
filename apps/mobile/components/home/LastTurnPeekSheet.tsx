// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A quick look at an agent's last turn, opened by pressing and holding its
 * row: what it was asked, the commands it ran, the files it changed, and what
 * it answered. Tap "Open chat" to go on from there.
 */
import { useMemo } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { AlertTriangle, Check, Loader2 } from 'lucide-react-native'
import type { AgentRow } from '../../lib/agent-urgency'
import { stateLabel } from '../../lib/agent-urgency'
import type { LastTurn } from '../../lib/last-turn'
import { useLastTurn } from '../../hooks/useLastTurn'
import { NativePhoneSheet } from '../phone/NativePhoneSheet'
import { fileChangeFromParams, IslandDiffPreview } from '../island/IslandDiffPreview'

const MAX_CHANGES = 4
const MAX_STEPS = 12

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="gap-1.5">
      <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</Text>
      {children}
    </View>
  )
}

function TurnBody({ turn }: { turn: LastTurn }) {
  const changes = useMemo(
    () =>
      turn.changes
        .map((c) => fileChangeFromParams(c.toolName, c.params))
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .slice(-MAX_CHANGES),
    [turn.changes],
  )
  const steps = turn.steps.slice(-MAX_STEPS)
  return (
    <View className="gap-4">
      {turn.prompt ? (
        <Section label="Asked">
          <Text className="text-sm text-foreground" numberOfLines={6}>
            {turn.prompt}
          </Text>
        </Section>
      ) : null}

      {steps.length ? (
        <Section label={turn.steps.length > steps.length ? `Did · last ${steps.length} of ${turn.steps.length}` : 'Did'}>
          <View className="gap-1.5">
            {steps.map((step) => (
              <View key={step.id} className="flex-row items-start gap-2">
                <View className="mt-0.5">
                  {step.state === 'done' ? (
                    <Check size={13} className="text-emerald-600" />
                  ) : step.state === 'failed' ? (
                    <AlertTriangle size={13} className="text-destructive" />
                  ) : (
                    <Loader2 size={13} className="text-primary" />
                  )}
                </View>
                <View className="min-w-0 flex-1">
                  <Text className="text-sm text-foreground">{step.label}</Text>
                  {step.detail ? (
                    <Text className="font-mono text-xs text-muted-foreground" numberOfLines={2}>
                      {step.detail}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        </Section>
      ) : null}

      {changes.length ? (
        <Section label={`Changed · ${changes.length} file${changes.length === 1 ? '' : 's'}`}>
          <View className="gap-2">
            {changes.map((change, index) => (
              <IslandDiffPreview key={`${change.path}:${index}`} change={change} />
            ))}
          </View>
        </Section>
      ) : null}

      {turn.answer ? (
        <Section label={turn.running ? 'Latest' : 'Answer'}>
          <Text className="text-sm text-foreground" numberOfLines={12}>
            {turn.answer}
          </Text>
        </Section>
      ) : null}
    </View>
  )
}

export function LastTurnPeekSheet({ row, onClose, onOpen }: { row: AgentRow | null; onClose: () => void; onOpen: (row: AgentRow) => void }) {
  const { turn, loading, error } = useLastTurn(row?.chatSessionId, row !== null)
  return (
    <NativePhoneSheet
      visible={row !== null}
      onClose={onClose}
      title={row?.name}
      subtitle={row ? stateLabel(row.state) : undefined}
      scroll
      draggable
      animationType="slide"
      testID="last-turn-peek"
      footer={
        row ? (
          <View className="px-4 pb-3 pt-2">
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                onClose()
                onOpen(row)
              }}
              className="items-center rounded-xl bg-primary py-3 active:opacity-90"
            >
              <Text className="text-sm font-semibold text-primary-foreground">Open chat</Text>
            </Pressable>
          </View>
        ) : undefined
      }
    >
      <View className="px-4 pb-4 pt-2">
        {!row?.chatSessionId ? (
          <Text className="py-6 text-center text-sm text-muted-foreground">There is no chat to look at yet.</Text>
        ) : loading && !turn ? (
          <View className="items-center py-8">
            <ActivityIndicator />
          </View>
        ) : error ? (
          <Text className="py-6 text-center text-sm text-destructive">{error}</Text>
        ) : turn ? (
          <TurnBody turn={turn} />
        ) : (
          <Text className="py-6 text-center text-sm text-muted-foreground">Nothing here yet.</Text>
        )}
      </View>
    </NativePhoneSheet>
  )
}
