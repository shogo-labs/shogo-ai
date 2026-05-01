// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Sub-Agent Models Section — Phase 1.2 (boss concern #2: user control)
 *
 * Lists every built-in sub-agent type alongside its current effective model,
 * a dropdown of supported alternatives with cost-per-1M output tokens, and
 * a Reset action that drops the override back to the built-in default. Custom
 * agent overrides created from recommendations are listed below the built-ins.
 *
 * Resolution order surfaced to the user:
 *   project-override  >  workspace-override  >  built-in/custom default
 *
 * Override changes take effect on the next sub-agent spawn (the runtime caches
 * resolutions for ~30s — see resolveSubagentModel in agent-runtime/subagent.ts).
 */

import { useCallback, useEffect, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { Cpu, RefreshCcw, Check } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Card, CardContent, Button } from '@shogo/shared-ui/primitives'
import { getModelColor, getModelDisplayName, getModelTextColor } from './SharedAnalytics'

// ============================================================================
// Built-in sub-agent catalog — kept in sync with getBuiltinSubagentConfig()
// in packages/agent-runtime/src/subagent.ts. Hard-coded here because the API
// doesn't expose a "list built-in sub-agents" endpoint yet, and re-deriving
// it from the runtime would require a new round-trip.
// ============================================================================

interface BuiltinSubagent {
  agentType: string
  description: string
  defaultModel: string
}

const BUILTIN_SUBAGENTS: readonly BuiltinSubagent[] = [
  {
    agentType: 'explore',
    description: 'Read-only codebase exploration. Highest spawn volume.',
    defaultModel: 'claude-haiku-4-5',
  },
  {
    agentType: 'general-purpose',
    description: 'Generic helper for non-specialised tasks.',
    defaultModel: 'claude-sonnet-4-6',
  },
  {
    agentType: 'browser_qa',
    description: 'Browser automation and visual QA.',
    defaultModel: 'gpt-5.4-nano',
  },
] as const

// ============================================================================
// Model catalog (per-1M output dollar costs — ground truth lives in
// @shogo/model-catalog → MODEL_DOLLAR_COSTS, surfaced here for the dropdown).
// ============================================================================

interface ModelChoice {
  model: string
  /** Human-readable per-1M output dollar cost. */
  costPer1M: number
  tier: 'fast' | 'balanced' | 'capable' | 'premium'
}

const MODEL_CATALOG: readonly ModelChoice[] = [
  { model: 'gpt-5.4-nano', costPer1M: 1.25, tier: 'fast'     },
  { model: 'claude-haiku-4-5', costPer1M: 5.0, tier: 'fast'     },
  { model: 'gpt-5.4-mini', costPer1M: 4.4,  tier: 'balanced' },
  { model: 'claude-sonnet-4-6', costPer1M: 15,   tier: 'balanced' },
  { model: 'claude-opus-4-7', costPer1M: 25,   tier: 'premium'  },
] as const

// ============================================================================
// Component
// ============================================================================

interface SubagentOverride {
  id: string
  workspaceId: string
  projectId: string | null
  agentType: string
  model: string
  provider: string | null
  updatedBy: string | null
  createdAt: string
  updatedAt: string
}

export interface SubAgentModelsSectionProps {
  workspaceId: string
  /**
   * GET /workspaces/:id/cost-analytics/subagent-overrides — returns the
   * workspace's full override list.
   */
  fetchOverrides: () => Promise<SubagentOverride[] | null>
  /** POST — upsert a single override. */
  putOverride: (body: {
    agentType: string
    model: string
    provider?: string | null
    projectId?: string | null
  }) => Promise<unknown>
  /** DELETE — drop an override (resets to the built-in default). */
  deleteOverride: (agentType: string, projectId?: string | null) => Promise<unknown>
  /** Optional callback when an override is changed — used by the parent to
   * refresh the recommendation list so "Apply" rows disappear. */
  onChange?: () => void
}

export function SubAgentModelsSection({
  fetchOverrides,
  putOverride,
  deleteOverride,
  onChange,
}: SubAgentModelsSectionProps) {
  const [overrides, setOverrides] = useState<SubagentOverride[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pendingAgentType, setPendingAgentType] = useState<string | null>(null)
  const [openDropdown, setOpenDropdown] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchOverrides()
      setOverrides(data)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load sub-agent overrides')
      setOverrides(null)
    } finally {
      setLoading(false)
    }
  }, [fetchOverrides])

  useEffect(() => { load() }, [load])

  const overrideFor = (agentType: string) =>
    (overrides ?? []).find(o => o.agentType === agentType && o.projectId === null) ?? null

  const handleApply = useCallback(async (agentType: string, model: string) => {
    setPendingAgentType(agentType)
    setError(null)
    try {
      await putOverride({ agentType, model, projectId: null })
      await load()
      onChange?.()
    } catch (err: any) {
      setError(err?.message ?? 'Failed to apply sub-agent override')
    } finally {
      setPendingAgentType(null)
      setOpenDropdown(null)
    }
  }, [putOverride, load, onChange])

  const handleReset = useCallback(async (agentType: string) => {
    setPendingAgentType(agentType)
    setError(null)
    try {
      await deleteOverride(agentType, null)
      await load()
      onChange?.()
    } catch (err: any) {
      setError(err?.message ?? 'Failed to reset sub-agent override')
    } finally {
      setPendingAgentType(null)
    }
  }, [deleteOverride, load, onChange])

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 items-center">
          <ActivityIndicator size="small" />
          <Text className="text-xs text-muted-foreground mt-2">Loading sub-agent models…</Text>
        </CardContent>
      </Card>
    )
  }

  return (
    <View className="gap-3">
      <View>
        <Text className="text-sm font-semibold text-foreground mb-1">Sub-Agent Models</Text>
        <Text className="text-[11px] text-muted-foreground leading-4">
          Override which model each sub-agent uses. Built-ins can be edited here;
          custom agents appear after an Optimize recommendation is applied. Changes
          take effect on the next spawn.
        </Text>
      </View>

      {error && (
        <Card>
          <CardContent className="p-3">
            <Text className="text-xs text-red-400">{error}</Text>
          </CardContent>
        </Card>
      )}

      {BUILTIN_SUBAGENTS.map((agent) => {
        const override = overrideFor(agent.agentType)
        const effectiveModel = override?.model ?? agent.defaultModel
        const isCustom = !!override
        const isOpen = openDropdown === agent.agentType
        const isPending = pendingAgentType === agent.agentType

        return (
          <Card key={agent.agentType}>
            <CardContent className="p-3">
              <View className="flex-row items-start justify-between gap-2 mb-2">
                <View className="flex-row items-center gap-2 flex-1">
                  <View className="h-8 w-8 rounded-lg bg-primary/10 items-center justify-center">
                    <Cpu size={14} className="text-primary" />
                  </View>
                  <View className="flex-1">
                    <Text className="text-sm font-semibold text-foreground">{agent.agentType}</Text>
                    <Text className="text-[10px] text-muted-foreground" numberOfLines={2}>
                      {agent.description}
                    </Text>
                  </View>
                </View>
                {isCustom && (
                  <Pressable
                    onPress={() => handleReset(agent.agentType)}
                    disabled={isPending}
                    className="flex-row items-center gap-1 px-2 py-1 rounded-md border border-border"
                  >
                    <RefreshCcw size={10} className="text-muted-foreground" />
                    <Text className="text-[10px] font-medium text-muted-foreground">Reset</Text>
                  </Pressable>
                )}
              </View>

              <Pressable
                onPress={() => setOpenDropdown(isOpen ? null : agent.agentType)}
                className="flex-row items-center justify-between rounded-lg border border-border bg-background px-2.5 py-2"
              >
                <View className="flex-row items-center gap-2">
                  <View className={cn('px-1.5 py-0.5 rounded border', getModelColor(effectiveModel))}>
                    <Text className={cn('text-[10px] font-medium', getModelTextColor(effectiveModel))}>
                      {getModelDisplayName(effectiveModel)}
                    </Text>
                  </View>
                  {isCustom ? (
                    <Text className="text-[10px] text-amber-400">overridden</Text>
                  ) : (
                    <Text className="text-[10px] text-muted-foreground">default</Text>
                  )}
                </View>
                <Text className="text-[10px] font-medium text-muted-foreground">
                  ${costFor(effectiveModel)} / 1M out
                </Text>
              </Pressable>

              {isOpen && (
                <View className="mt-2 rounded-lg border border-border bg-card overflow-hidden">
                  {MODEL_CATALOG.map((choice) => {
                    const isSelected = choice.model === effectiveModel
                    return (
                      <Pressable
                        key={choice.model}
                        onPress={() => handleApply(agent.agentType, choice.model)}
                        disabled={isPending}
                        className={cn(
                          'flex-row items-center justify-between px-3 py-2.5',
                          isSelected ? 'bg-primary/5' : '',
                        )}
                      >
                        <View className="flex-row items-center gap-2 flex-1">
                          <View className={cn('px-1.5 py-0.5 rounded border', getModelColor(choice.model))}>
                            <Text className={cn('text-[10px] font-medium', getModelTextColor(choice.model))}>
                              {getModelDisplayName(choice.model)}
                            </Text>
                          </View>
                          <Text className="text-[10px] text-muted-foreground">{choice.tier}</Text>
                          {choice.model === agent.defaultModel && (
                            <Text className="text-[9px] text-muted-foreground">(built-in default)</Text>
                          )}
                        </View>
                        <View className="flex-row items-center gap-1.5">
                          <Text className="text-[10px] font-medium text-foreground">
                            ${choice.costPer1M.toFixed(2)}/1M
                          </Text>
                          {isSelected && <Check size={12} className="text-primary" />}
                        </View>
                      </Pressable>
                    )
                  })}
                </View>
              )}

              {isPending && (
                <View className="flex-row items-center justify-center mt-2 gap-1.5">
                  <ActivityIndicator size="small" />
                  <Text className="text-[10px] text-muted-foreground">Applying…</Text>
                </View>
              )}
            </CardContent>
          </Card>
        )
      })}

      {(overrides ?? []).filter(o => !BUILTIN_SUBAGENTS.some(b => b.agentType === o.agentType)).length > 0 && (
        <View className="mt-1">
          <Text className="text-[11px] font-medium text-muted-foreground mb-1.5">Custom agent types with model overrides</Text>
          {(overrides ?? [])
            .filter(o => !BUILTIN_SUBAGENTS.some(b => b.agentType === o.agentType))
            .map((o) => (
              <Card key={o.id} className="mb-1.5">
                <CardContent className="p-2.5 flex-row items-center justify-between">
                  <Text className="text-xs font-medium text-foreground">{o.agentType}</Text>
                  <View className="flex-row items-center gap-2">
                    <View className={cn('px-1.5 py-0.5 rounded border', getModelColor(o.model))}>
                      <Text className={cn('text-[10px] font-medium', getModelTextColor(o.model))}>
                        {getModelDisplayName(o.model)}
                      </Text>
                    </View>
                    <Button variant="outline" onPress={() => handleReset(o.agentType)}>
                      <Text className="text-[10px] font-medium text-foreground">Reset</Text>
                    </Button>
                  </View>
                </CardContent>
              </Card>
            ))}
        </View>
      )}
    </View>
  )
}

function costFor(model: string): string {
  const normalized =
    model === 'haiku' ? 'claude-haiku-4-5'
      : model === 'sonnet' ? 'claude-sonnet-4-6'
        : model === 'opus' ? 'claude-opus-4-7'
          : model
  const entry = MODEL_CATALOG.find(c => c.model === normalized)
  return entry ? entry.costPer1M.toFixed(2) : '—'
}
