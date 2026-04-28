// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Recommendations Section — Phase 4.3 (split out of CostAnalyticsTab).
 *
 * Renders the multi-signal-gated cost recommendations with an "Apply" button
 * that writes a sub-agent override (Phase 1.3) and a confidence breakdown
 * citing every gate dimension (Phase 2.3).
 *
 * Pure-render component — fetching + Apply persistence are the parent's
 * responsibility.
 */

import { useState } from 'react'
import { View, Text, ActivityIndicator } from 'react-native'
import {
  Lightbulb, TrendingDown, TrendingUp, ArrowRightLeft, Check,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Card, CardContent, Button } from '@shogo/shared-ui/primitives'
import { formatDollarCost, getModelColor, getModelDisplayName, getModelTextColor } from './SharedAnalytics'

export interface CostRecommendation {
  agentType: string
  currentModel: string
  recommendedModel: string
  reason: string
  estimatedSavingsPercent: number
  estimatedMonthlySavings: number
  confidence: 'high' | 'medium' | 'low'
  currentMonthlyCost: number
  /** Phase 2.3 — multi-signal audit trail backing this recommendation. */
  evidence?: {
    runs: number
    qualitySuccessRate: number
    escalationRate: number
    loopTrips: number
    maxTurnHits: number
    evalAnchor?: { suite: string; passRate: number; model: string }
  }
}

interface RecommendationsSectionProps {
  data: CostRecommendation[] | null
  loading: boolean
  /**
   * Phase 1.3 — when provided, each row gets an "Apply" button that writes
   * the sub-agent override and refreshes the dashboard. Undefined → row is
   * read-only (used by hosts that haven't wired up override CRUD yet).
   */
  onApply?: (rec: CostRecommendation) => Promise<void>
}

export function RecommendationsSection({ data, loading, onApply }: RecommendationsSectionProps) {
  const [applying, setApplying] = useState<string | null>(null)
  const [applied, setApplied] = useState<Set<string>>(new Set())

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 items-center">
          <ActivityIndicator />
          <Text className="text-xs text-muted-foreground mt-2">Loading…</Text>
        </CardContent>
      </Card>
    )
  }

  const recs = data ?? []

  if (recs.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 items-center">
          <Lightbulb size={24} className="text-muted-foreground mb-2" />
          <Text className="text-sm font-medium text-foreground mb-1">No recommendations yet</Text>
          <Text className="text-xs text-muted-foreground text-center max-w-[280px]">
            Once an agent/model pair has enough usage data (20+ runs), optimization recommendations will appear here.
          </Text>
        </CardContent>
      </Card>
    )
  }

  const recommendationKey = (rec: CostRecommendation) =>
    `${rec.agentType}:${rec.currentModel}:${rec.recommendedModel}`

  const handleApply = async (rec: CostRecommendation) => {
    if (!onApply) return
    const key = recommendationKey(rec)
    setApplying(key)
    try {
      await onApply(rec)
      setApplied(prev => new Set(prev).add(key))
    } catch {
      /* error toast handled upstream */
    } finally {
      setApplying(null)
    }
  }

  return (
    <View className="gap-2">
      {recs.map((rec, i) => {
        const isSavings = rec.estimatedSavingsPercent > 0
        const recKey = recommendationKey(rec)
        const isApplying = applying === recKey
        const wasApplied = applied.has(recKey)
        const canApply = !!onApply && rec.agentType !== 'main-chat' && rec.currentModel !== rec.recommendedModel
        return (
          <Card key={i}>
            <CardContent className="p-3">
              <View className="flex-row items-start gap-2">
                <View className={cn(
                  'h-8 w-8 rounded-lg items-center justify-center mt-0.5',
                  isSavings ? 'bg-green-500/10' : 'bg-amber-500/10',
                )}>
                  {isSavings ? (
                    <TrendingDown size={14} className="text-green-400" />
                  ) : (
                    <TrendingUp size={14} className="text-amber-400" />
                  )}
                </View>
                <View className="flex-1">
                  <View className="flex-row items-center gap-2 mb-1">
                    <Text className="text-sm font-semibold text-foreground">{rec.agentType}</Text>
                    <View className={cn(
                      'px-1.5 py-0.5 rounded',
                      rec.confidence === 'high' ? 'bg-green-500/15' : rec.confidence === 'medium' ? 'bg-amber-500/15' : 'bg-muted',
                    )}>
                      <Text className={cn(
                        'text-[9px] font-medium',
                        rec.confidence === 'high' ? 'text-green-400' : rec.confidence === 'medium' ? 'text-amber-400' : 'text-muted-foreground',
                      )}>
                        {rec.confidence} confidence
                      </Text>
                    </View>
                  </View>

                  {rec.currentModel !== rec.recommendedModel && (
                    <View className="flex-row items-center gap-1.5 mb-2 flex-wrap">
                      <View className={cn('px-1.5 py-0.5 rounded border', getModelColor(rec.currentModel))}>
                        <Text className={cn('text-[10px] font-medium', getModelTextColor(rec.currentModel))}>
                          {getModelDisplayName(rec.currentModel)}
                        </Text>
                      </View>
                      <ArrowRightLeft size={10} className="text-muted-foreground" />
                      <View className={cn('px-1.5 py-0.5 rounded border', getModelColor(rec.recommendedModel))}>
                        <Text className={cn('text-[10px] font-medium', getModelTextColor(rec.recommendedModel))}>
                          {getModelDisplayName(rec.recommendedModel)}
                        </Text>
                      </View>
                      {isSavings && (
                        <Text className="text-[10px] font-bold text-green-400 ml-1">
                          Save ~{rec.estimatedSavingsPercent}%
                        </Text>
                      )}
                    </View>
                  )}

                  <Text className="text-xs text-muted-foreground leading-4">{rec.reason}</Text>

                  {rec.evidence && (
                    <View className="mt-2 rounded-md bg-muted/40 px-2 py-1.5">
                      <Text className="text-[9px] font-medium text-muted-foreground mb-1">
                        Confidence breakdown
                      </Text>
                      <View className="flex-row flex-wrap gap-x-3 gap-y-0.5">
                        <EvidenceChip label="runs" value={String(rec.evidence.runs)} />
                        <EvidenceChip
                          label="quality success"
                          value={`${rec.evidence.qualitySuccessRate}%`}
                          good={rec.evidence.qualitySuccessRate >= 85}
                          bad={rec.evidence.qualitySuccessRate < 60}
                        />
                        <EvidenceChip
                          label="escalations"
                          value={`${rec.evidence.escalationRate}%`}
                          good={rec.evidence.escalationRate < 10}
                          bad={rec.evidence.escalationRate >= 25}
                        />
                        <EvidenceChip
                          label="loop trips"
                          value={String(rec.evidence.loopTrips)}
                          good={rec.evidence.loopTrips === 0}
                          bad={rec.evidence.loopTrips > 0}
                        />
                        <EvidenceChip
                          label="max-turn hits"
                          value={String(rec.evidence.maxTurnHits)}
                          good={rec.evidence.maxTurnHits === 0}
                          bad={rec.evidence.maxTurnHits > 0}
                        />
                      </View>
                      {rec.evidence.evalAnchor && (
                        <Text className="text-[9px] text-muted-foreground mt-1">
                          Eval anchor: <Text className="font-medium text-foreground">{rec.evidence.evalAnchor.model}</Text> · <Text className="font-medium text-foreground">{Math.round(rec.evidence.evalAnchor.passRate * 100)}%</Text> pass · <Text className="font-medium">{rec.evidence.evalAnchor.suite}</Text>
                        </Text>
                      )}
                    </View>
                  )}

                  {rec.estimatedMonthlySavings !== 0 && (
                    <Text className={cn(
                      'text-[10px] font-medium mt-1',
                      isSavings ? 'text-green-400' : 'text-amber-400',
                    )}>
                      {isSavings ? '↓' : '↑'} Est. {formatDollarCost(Math.abs(rec.estimatedMonthlySavings))}/month
                      {rec.currentMonthlyCost > 0 ? ` (current: ${formatDollarCost(rec.currentMonthlyCost)}/mo)` : ''}
                    </Text>
                  )}

                  {canApply && (
                    <View className="mt-2 flex-row items-center gap-2">
                      <Button
                        onPress={() => handleApply(rec)}
                        disabled={isApplying || wasApplied}
                        variant={wasApplied ? 'outline' : 'default'}
                      >
                        <View className="flex-row items-center gap-1.5">
                          {wasApplied ? (
                            <Check size={12} className="text-foreground" />
                          ) : isApplying ? (
                            <ActivityIndicator size="small" />
                          ) : null}
                          <Text className={cn(
                            'text-xs font-medium',
                            wasApplied ? 'text-foreground' : 'text-primary-foreground',
                          )}>
                            {wasApplied
                              ? `Applied · ${rec.agentType} → ${getModelDisplayName(rec.recommendedModel)}`
                              : isApplying ? 'Applying…' : `Set workspace default for ${rec.agentType} to ${getModelDisplayName(rec.recommendedModel)}`}
                          </Text>
                        </View>
                      </Button>
                    </View>
                  )}
                </View>
              </View>
            </CardContent>
          </Card>
        )
      })}
    </View>
  )
}

function EvidenceChip({
  label,
  value,
  good,
  bad,
}: {
  label: string
  value: string
  good?: boolean
  bad?: boolean
}) {
  return (
    <Text className="text-[10px] text-muted-foreground">
      <Text className="font-medium">{label}: </Text>
      <Text
        className={cn(
          'font-semibold',
          good ? 'text-green-400' : bad ? 'text-red-400' : 'text-foreground',
        )}
      >
        {value}
      </Text>
    </Text>
  )
}
