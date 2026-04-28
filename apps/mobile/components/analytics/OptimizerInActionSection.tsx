// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Optimizer in Action Section — Phase 3.3 (boss "show me a real use case")
 *
 * Surfaces the artifact the boss asked for:
 *   1. Every sub-agent model override the workspace has applied — when, by
 *      whom, and the 30-day before/after cost & multi-signal quality numbers.
 *   2. The latest eval pass-rate per (agentType, model) so the user can see
 *      the evidence behind a recommendation.
 *   3. Any active shadow A/Bs with the multi-signal verdict.
 *   4. Aggregate $ saved per month across applied overrides.
 *
 * Pure-render component — fetching is the parent's responsibility.
 */

import { useMemo } from 'react'
import { View, Text, ActivityIndicator } from 'react-native'
import { TrendingDown, Beaker, GraduationCap, Wand2 } from 'lucide-react-native'
import { Card, CardContent } from '@shogo/shared-ui/primitives'
import { getModelDisplayName, getModelTextColor } from './SharedAnalytics'

// Inline copy of the response type so this file stays decoupled from api.ts.
export interface OptimizerInActionData {
  workspaceId: string
  generatedAt: string
  overrides: Array<{
    id: string
    agentType: string
    projectId: string | null
    fromModel: string | null
    toModel: string
    appliedAt: string
    updatedBy: string | null
    avgCostBefore: number | null
    avgCostAfter: number | null
    qualitySuccessBefore: number | null
    qualitySuccessAfter: number | null
    runsBefore: number
    runsAfter: number
  }>
  evalScores: Array<{
    agentType: string
    model: string
    suite: string
    passRate: number
    totalCases: number
    capturedAt: string
  }>
  experiments: Array<{
    id: string
    name: string
    agentType: string
    modelA: string
    modelB: string
    status: string
    expectedEndAt: string | null
    runsA: number
    runsB: number
    verdict: 'inconclusive' | 'A' | 'B' | 'tie'
    reasons: string[]
  }>
  monthlySavingsUSD: number
}

interface OptimizerInActionSectionProps {
  data: OptimizerInActionData | null
  isLoading: boolean
  error: string | null
}

function formatUSD(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1) return `$${value.toFixed(2)}`
  if (Math.abs(value) >= 0.01) return `$${value.toFixed(3)}`
  return value === 0 ? '$0' : `<$0.01`
}

function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(1)}%`
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) {
    const daysUntil = Math.ceil(Math.abs(ms) / (24 * 60 * 60 * 1000))
    if (daysUntil < 1) return 'today'
    if (daysUntil < 30) return `in ${daysUntil}d`
    return `in ${Math.ceil(daysUntil / 30)}mo`
  }
  const days = Math.floor(ms / (24 * 60 * 60 * 1000))
  if (days < 1) return 'today'
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

export function OptimizerInActionSection({ data, isLoading, error }: OptimizerInActionSectionProps) {
  const evalsByAgent = useMemo(() => {
    if (!data) return new Map<string, OptimizerInActionData['evalScores']>()
    const map = new Map<string, OptimizerInActionData['evalScores']>()
    for (const row of data.evalScores) {
      const arr = map.get(row.agentType) ?? []
      arr.push(row)
      map.set(row.agentType, arr)
    }
    return map
  }, [data])

  if (isLoading && !data) {
    return (
      <View className="py-8 items-center justify-center">
        <ActivityIndicator />
        <Text className="text-muted-foreground text-sm mt-2">Loading optimizer report…</Text>
      </View>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-3">
          <Text className="text-destructive text-sm">Failed to load: {error}</Text>
        </CardContent>
      </Card>
    )
  }

  if (!data) return null

  const hasContent = data.overrides.length > 0 || data.experiments.length > 0 || data.evalScores.length > 0

  if (!hasContent) {
    return (
      <Card>
        <CardContent className="p-6">
          <View className="py-6 items-center">
            <Wand2 size={32} className="text-muted-foreground" />
            <Text className="text-foreground font-semibold mt-3">No optimizations applied yet</Text>
            <Text className="text-muted-foreground text-sm mt-1 text-center">
              Apply a recommendation from the Recommendations tab to see before/after data here.
            </Text>
          </View>
        </CardContent>
      </Card>
    )
  }

  return (
    <View className="gap-4">
      {/* ── Headline ──────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-3">
          <View className="flex-row items-center gap-3">
            <TrendingDown size={28} className="text-emerald-500" />
            <View className="flex-1">
              <Text className="text-foreground text-xs uppercase tracking-wider">
                Estimated monthly savings (so far)
              </Text>
              <Text className="text-foreground text-3xl font-bold mt-1">
                {formatUSD(data.monthlySavingsUSD)}
              </Text>
              <Text className="text-muted-foreground text-xs mt-1">
                Based on 30-day before/after windows around each override.
              </Text>
            </View>
          </View>
        </CardContent>
      </Card>

      {/* ── Applied overrides ─────────────────────────────────── */}
      {data.overrides.length > 0 && (
        <View className="gap-2">
          <Text className="text-foreground font-semibold">Applied overrides</Text>
          {data.overrides.map((ov) => {
            const delta = ov.avgCostBefore != null && ov.avgCostAfter != null
              ? ov.avgCostBefore - ov.avgCostAfter
              : null
            const deltaPct = delta != null && ov.avgCostBefore && ov.avgCostBefore > 0
              ? (delta / ov.avgCostBefore) * 100
              : null
            return (
              <Card key={ov.id}>
                <CardContent className="p-3">
                  <View className="flex-row items-start justify-between">
                    <View className="flex-1">
                      <Text className="text-foreground font-medium">{ov.agentType}</Text>
                      <Text className="text-muted-foreground text-xs mt-0.5">
                        Applied {formatRelative(ov.appliedAt)}
                        {ov.updatedBy ? ` by ${ov.updatedBy.slice(0, 8)}` : ''}
                      </Text>
                    </View>
                    <Text className={`text-sm ${getModelTextColor(ov.toModel)}`}>
                      → {getModelDisplayName(ov.toModel)}
                    </Text>
                  </View>

                  <View className="flex-row gap-4 mt-3">
                    <View className="flex-1">
                      <Text className="text-muted-foreground text-xs">Avg $ / run</Text>
                      <Text className="text-foreground text-sm">
                        {formatUSD(ov.avgCostBefore)} → {formatUSD(ov.avgCostAfter)}
                      </Text>
                      {deltaPct != null && (
                        <Text className={delta && delta > 0 ? 'text-emerald-500 text-xs mt-0.5' : 'text-muted-foreground text-xs mt-0.5'}>
                          {delta && delta > 0 ? '↓' : '↑'} {Math.abs(deltaPct).toFixed(1)}%
                        </Text>
                      )}
                    </View>
                    <View className="flex-1">
                      <Text className="text-muted-foreground text-xs">Quality success</Text>
                      <Text className="text-foreground text-sm">
                        {formatPercent(ov.qualitySuccessBefore)} → {formatPercent(ov.qualitySuccessAfter)}
                      </Text>
                      <Text className="text-muted-foreground text-xs mt-0.5">
                        {ov.runsBefore} → {ov.runsAfter} runs
                      </Text>
                    </View>
                  </View>
                </CardContent>
              </Card>
            )
          })}
        </View>
      )}

      {/* ── Active experiments ─────────────────────────────────── */}
      {data.experiments.length > 0 && (
        <View className="gap-2">
          <View className="flex-row items-center gap-2">
            <Beaker size={16} className="text-foreground" />
            <Text className="text-foreground font-semibold">Active experiments</Text>
          </View>
          {data.experiments.map((exp) => (
            <Card key={exp.id}>
              <CardContent className="p-3">
                <View className="flex-row items-start justify-between">
                  <View className="flex-1">
                    <Text className="text-foreground font-medium">{exp.name}</Text>
                    <Text className="text-muted-foreground text-xs mt-0.5">
                      {exp.modelA} ({exp.runsA} runs) vs {exp.modelB} ({exp.runsB} runs)
                      {' · '}
                      {exp.status}
                      {exp.expectedEndAt ? ` · ends ${formatRelative(exp.expectedEndAt)}` : ''}
                    </Text>
                  </View>
                  <View className={
                    exp.verdict === 'B' ? 'bg-emerald-500/10 px-2 py-1 rounded-md' :
                      exp.verdict === 'A' ? 'bg-amber-500/10 px-2 py-1 rounded-md' :
                        'bg-muted px-2 py-1 rounded-md'
                  }>
                    <Text className="text-xs font-semibold text-foreground">
                      Verdict: {exp.verdict === 'B' ? `→ ${exp.modelB}` : exp.verdict === 'A' ? `keep ${exp.modelA}` : exp.verdict}
                    </Text>
                  </View>
                </View>
                {exp.reasons.length > 0 && (
                  <Text className="text-muted-foreground text-xs mt-2">
                    {exp.reasons.join(' ')}
                  </Text>
                )}
                {exp.runsA + exp.runsB === 0 && (
                  <Text className="text-muted-foreground text-xs mt-2">
                    Waiting for future matching built-in subagent runs. Main chat runs are not counted in A/B tests.
                  </Text>
                )}
              </CardContent>
            </Card>
          ))}
        </View>
      )}

      {/* ── Eval scores per (agent, model) ────────────────────── */}
      {data.evalScores.length > 0 && (
        <View className="gap-2">
          <View className="flex-row items-center gap-2">
            <GraduationCap size={16} className="text-foreground" />
            <Text className="text-foreground font-semibold">Eval pass-rates</Text>
          </View>
          {Array.from(evalsByAgent.entries()).map(([agentType, rows]) => (
            <Card key={agentType}>
              <CardContent className="p-3">
                <Text className="text-foreground font-medium">{agentType}</Text>
                <View className="mt-2 gap-1">
                  {rows.map((r) => (
                    <View key={`${r.agentType}::${r.model}`} className="flex-row justify-between">
                      <Text className={`text-sm ${getModelTextColor(r.model)}`}>
                        {getModelDisplayName(r.model)}
                      </Text>
                      <Text className="text-foreground text-sm">
                        {(r.passRate * 100).toFixed(1)}% ({r.totalCases} cases · {formatRelative(r.capturedAt)})
                      </Text>
                    </View>
                  ))}
                </View>
              </CardContent>
            </Card>
          ))}
        </View>
      )}
    </View>
  )
}
