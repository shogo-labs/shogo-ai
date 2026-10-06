// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A small glass recap under the newest finished turn: steps run, files
 * changed, anything that failed. Only the newest turn gets one, so a long chat
 * does not stack up native glass views.
 */
import { Text, View } from 'react-native'
import { AlertTriangle, CheckCircle2 } from 'lucide-react-native'
import { summarizeTurnTools, turnSummaryText } from '../../../lib/turn-summary'
import type { ToolCallData } from '../tools/types'
import { GlassCard } from '../../ui/GlassCard'

export function TurnSummaryCard({ toolCalls }: { toolCalls: ToolCallData[] }) {
  const summary = summarizeTurnTools(toolCalls)
  const text = turnSummaryText(summary)
  if (!text) return null
  const failed = summary.failed > 0
  return (
    <GlassCard radius={14} tint={failed ? 'rgba(239,68,68,0.12)' : undefined} style={{ alignSelf: 'flex-start', marginTop: 6, marginLeft: 10 }} testID="turn-summary">
      <View className="flex-row items-center gap-2 px-3 py-2">
        {failed ? <AlertTriangle size={14} className="text-destructive" /> : <CheckCircle2 size={14} className="text-emerald-600" />}
        <Text className="text-xs font-medium text-foreground">{text}</Text>
      </View>
    </GlassCard>
  )
}
