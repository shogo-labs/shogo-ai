// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Experiments Section — Phase 4.3 (split out of CostAnalyticsTab).
 *
 * Renders A/B model experiments with side-by-side variant cards, plus a "New
 * Experiment" form. Stop / refresh actions go through the parent's
 * `postCostAnalytics`.
 *
 * The shadow-experiment quality counters from Phase 3.2 surface inside the
 * "Optimizer in Action" section instead of here so this view stays focused on
 * actionable A/B controls.
 */

import { useState } from 'react'
import { View, Text, TextInput, ActivityIndicator, Pressable } from 'react-native'
import { FlaskConical, Plus } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Card, CardContent, Button } from '@shogo/shared-ui/primitives'
import {
  formatDollarCost,
  formatDuration,
  getModelColor,
  getModelDisplayName,
  getModelTextColor,
} from './SharedAnalytics'

export interface ExperimentItem {
  id: string
  name: string
  agentType: string
  modelA: string
  modelB: string
  status: string
  splitPercentage: number
  totalRunsA: number
  totalRunsB: number
  totalCostA: number
  totalCostB: number
  successRateA: number
  successRateB: number
  avgLatencyMsA: number
  avgLatencyMsB: number
}

interface ExperimentsSectionProps {
  data: ExperimentItem[] | null
  loading: boolean
  onRefresh: () => void
  postCostAnalytics: <T>(endpoint: string, body: Record<string, unknown>) => Promise<T>
}

const SUPPORTED_AGENT_TYPES = [
  'explore',
  'general-purpose',
  'code-reviewer',
  'browser',
  'browser_qa',
  'integration',
  'channel',
  'media',
  'devops',
] as const

const MODEL_OPTIONS = [
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
] as const

export function ExperimentsSection({
  data,
  loading,
  onRefresh,
  postCostAnalytics,
}: ExperimentsSectionProps) {
  const [showCreate, setShowCreate] = useState(false)
  const [formName, setFormName] = useState('')
  const [formAgent, setFormAgent] = useState('')
  const [formModelA, setFormModelA] = useState('')
  const [formModelB, setFormModelB] = useState('')
  const [creating, setCreating] = useState(false)

  if (loading) {
    return (
      <Card>
        <CardContent className="p-8 items-center">
          <ActivityIndicator size="small" />
          <Text className="text-xs text-muted-foreground mt-2">Loading...</Text>
        </CardContent>
      </Card>
    )
  }

  const handleCreate = async () => {
    if (!formName.trim() || !formAgent.trim() || !formModelA.trim() || !formModelB.trim()) return
    setCreating(true)
    try {
      await postCostAnalytics('experiments', {
        name: formName.trim(),
        agentType: formAgent.trim(),
        modelA: formModelA.trim(),
        modelB: formModelB.trim(),
      })
      setFormName('')
      setFormAgent('')
      setFormModelA('')
      setFormModelB('')
      setShowCreate(false)
      onRefresh()
    } catch { /* handled */ }
    setCreating(false)
  }

  const handleStop = async (id: string) => {
    try {
      await postCostAnalytics(`experiments/${id}/stop`, {})
      onRefresh()
    } catch { /* handled */ }
  }

  const experiments = data ?? []

  return (
    <View className="gap-3">
      {experiments.length === 0 && !showCreate ? (
        <Card>
          <CardContent className="p-6 items-center">
            <FlaskConical size={24} className="text-muted-foreground mb-2" />
            <Text className="text-sm font-medium text-foreground mb-1">No experiments</Text>
            <Text className="text-xs text-muted-foreground text-center max-w-[280px] mb-3">
              A/B test different models on the same built-in subagent. Only future matching subagent runs are counted.
            </Text>
            <Button variant="outline" onPress={() => setShowCreate(true)}>
              <View className="flex-row items-center gap-1.5">
                <Plus size={12} className="text-foreground" />
                <Text className="text-sm font-medium text-foreground">New Experiment</Text>
              </View>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {experiments.map((exp) => {
            const isRunning = exp.status === 'running' || exp.status === 'shadow'
            const totalRuns = exp.totalRunsA + exp.totalRunsB
            const totalCost = exp.totalCostA + exp.totalCostB
            const costPerRunA = exp.totalRunsA > 0 ? (exp.totalCostA / exp.totalRunsA) : 0
            const costPerRunB = exp.totalRunsB > 0 ? (exp.totalCostB / exp.totalRunsB) : 0

            return (
              <Card key={exp.id}>
                <CardContent className="p-3">
                  <View className="flex-row items-center justify-between mb-2">
                    <View className="flex-row items-center gap-2">
                      <FlaskConical size={14} className={isRunning ? 'text-primary' : 'text-muted-foreground'} />
                      <Text className="text-sm font-semibold text-foreground">{exp.name}</Text>
                    </View>
                    <View className={cn(
                      'px-1.5 py-0.5 rounded',
                      isRunning ? 'bg-green-500/15' : 'bg-muted',
                    )}>
                      <Text className={cn('text-[9px] font-medium', isRunning ? 'text-green-400' : 'text-muted-foreground')}>
                        {exp.status}
                      </Text>
                    </View>
                  </View>

                  <Text className="text-[10px] text-muted-foreground mb-2">
                    Agent: {exp.agentType} · {totalRuns} total runs · {formatDollarCost(totalCost)}
                  </Text>
                  {totalRuns === 0 && (
                    <Text className="text-[10px] text-muted-foreground mb-2">
                      No matching subagent runs recorded yet. Main chat runs do not count, and completed experiments no longer collect results.
                    </Text>
                  )}

                  <View className="flex-row gap-2">
                    <ExperimentVariantCard
                      label="Model A"
                      model={exp.modelA}
                      runs={exp.totalRunsA}
                      cost={exp.totalCostA}
                      costPerRun={costPerRunA}
                      successRate={exp.successRateA}
                      latency={exp.avgLatencyMsA}
                    />
                    <ExperimentVariantCard
                      label="Model B"
                      model={exp.modelB}
                      runs={exp.totalRunsB}
                      cost={exp.totalCostB}
                      costPerRun={costPerRunB}
                      successRate={exp.successRateB}
                      latency={exp.avgLatencyMsB}
                    />
                  </View>

                  {isRunning && (
                    <Button variant="outline" onPress={() => handleStop(exp.id)} className="mt-2">
                      <Text className="text-xs font-medium text-foreground">Stop Experiment</Text>
                    </Button>
                  )}
                </CardContent>
              </Card>
            )
          })}

          <Button variant="outline" onPress={() => setShowCreate(true)}>
            <View className="flex-row items-center gap-1.5">
              <Plus size={12} className="text-foreground" />
              <Text className="text-sm font-medium text-foreground">New Experiment</Text>
            </View>
          </Button>
        </>
      )}

      {showCreate && (
        <Card>
          <CardContent className="p-3 gap-3">
            <Text className="text-sm font-semibold text-foreground">New A/B Experiment</Text>
            <Text className="text-[10px] text-muted-foreground">
              Experiments route future built-in subagent runs only. Main chat model routing is not affected.
            </Text>
            <TextInput
              className="h-9 px-3 rounded-lg border border-border bg-background text-sm text-foreground"
              placeholder="Experiment name"
              placeholderTextColor="#888"
              value={formName}
              onChangeText={setFormName}
            />
            <TextInput
              className="h-9 px-3 rounded-lg border border-border bg-background text-sm text-foreground"
              placeholder="Agent type (e.g. explore, general-purpose)"
              placeholderTextColor="#888"
              value={formAgent}
              onChangeText={setFormAgent}
            />
            <OptionRow
              values={SUPPORTED_AGENT_TYPES}
              selected={formAgent}
              onSelect={setFormAgent}
              formatLabel={(value) => value}
            />
            <View className="flex-row gap-2">
              <TextInput
                className="h-9 px-3 rounded-lg border border-border bg-background text-sm text-foreground flex-1"
                placeholder="Model A (e.g. claude-haiku-4-5)"
                placeholderTextColor="#888"
                value={formModelA}
                onChangeText={setFormModelA}
              />
              <TextInput
                className="h-9 px-3 rounded-lg border border-border bg-background text-sm text-foreground flex-1"
                placeholder="Model B (e.g. claude-sonnet-4-6)"
                placeholderTextColor="#888"
                value={formModelB}
                onChangeText={setFormModelB}
              />
            </View>
            <OptionRow
              values={MODEL_OPTIONS}
              selected={formModelA}
              onSelect={setFormModelA}
            />
            <OptionRow
              values={MODEL_OPTIONS}
              selected={formModelB}
              onSelect={setFormModelB}
            />
            <View className="flex-row gap-2">
              <Button variant="outline" onPress={() => setShowCreate(false)} className="flex-1">
                <Text className="text-sm font-medium text-foreground">Cancel</Text>
              </Button>
              <Button onPress={handleCreate} disabled={creating} className="flex-1">
                <Text className="text-sm font-medium text-primary-foreground">
                  {creating ? 'Creating...' : 'Create'}
                </Text>
              </Button>
            </View>
          </CardContent>
        </Card>
      )}
    </View>
  )
}

function OptionRow({
  values,
  selected,
  onSelect,
  formatLabel = getModelDisplayName,
}: {
  values: readonly string[]
  selected: string
  onSelect: (value: string) => void
  formatLabel?: (value: string) => string
}) {
  return (
    <View className="flex-row flex-wrap gap-1">
      {values.map(value => {
        const isSelected = selected === value
        return (
          <Pressable
            key={value}
            onPress={() => onSelect(value)}
            className={cn(
              'px-2 py-1 rounded-md border',
              isSelected ? 'bg-primary/10 border-primary/40' : 'bg-muted/30 border-border',
            )}
          >
            <Text className={cn('text-[10px]', isSelected ? 'text-primary' : 'text-muted-foreground')}>
              {formatLabel(value)}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function ExperimentVariantCard({
  label,
  model,
  runs,
  cost,
  costPerRun,
  successRate,
  latency,
}: {
  label: string
  model: string
  runs: number
  cost: number
  costPerRun: number
  successRate: number
  latency: number
}) {
  return (
    <View className="flex-1 rounded-lg border border-border bg-muted/30 p-2">
      <Text className="text-[9px] font-medium text-muted-foreground mb-1">{label}</Text>
      <View className={cn('px-1.5 py-0.5 rounded border self-start mb-1.5', getModelColor(model))}>
        <Text className={cn('text-[10px] font-medium', getModelTextColor(model))}>
          {getModelDisplayName(model)}
        </Text>
      </View>
      <View className="gap-0.5">
        <Text className="text-[10px] text-foreground">{runs} runs</Text>
        <Text className="text-[10px] text-foreground">{formatDollarCost(cost)} total</Text>
        <Text className="text-[10px] text-foreground">{formatDollarCost(costPerRun)}/run</Text>
        <Text className="text-[10px] text-foreground">{successRate.toFixed(1)}% success</Text>
        <Text className="text-[10px] text-foreground">{formatDuration(latency)} avg</Text>
      </View>
    </View>
  )
}
