// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Budget Section — Phase 4.3 (split out of CostAnalyticsTab).
 *
 * Renders configured budget alerts with their breach status (under-budget /
 * warning / breached) plus an inline create form. The auto-throttle banner
 * surfaces when a breach has triggered the cheaper-model fallback.
 *
 * Pure-render — alert CRUD goes through the parent's `postCostAnalytics` and
 * the parent owns refresh on mutation.
 */

import { useState } from 'react'
import { View, Text, TextInput } from 'react-native'
import { Bell, Plus } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Card, CardContent, Button } from '@shogo/shared-ui/primitives'
import { formatDollarCost, getModelDisplayName } from './SharedAnalytics'

export interface BudgetAlertItem {
  id: string
  name: string
  creditLimit: number
  periodType: string
  enabled: boolean
  autoThrottle: boolean
  throttleToModel: string | null
  lastTriggeredAt: string | null
}

export interface BudgetStatus {
  usage?: Array<{
    alert: { id: string; name: string; creditLimit: number; autoThrottle: boolean; throttleToModel: string | null }
    currentSpend: number
    percentUsed: number
  }>
  breached: Array<{
    alert: { id: string; name: string; creditLimit: number; autoThrottle: boolean; throttleToModel: string | null }
    currentSpend: number
    percentUsed: number
  }>
  throttleModel: string | null
}

interface BudgetSectionProps {
  alerts: BudgetAlertItem[] | null
  status: BudgetStatus | null
  loading: boolean
  onRefresh: () => void
  postCostAnalytics: <T>(endpoint: string, body: Record<string, unknown>) => Promise<T>
}

export function BudgetSection({
  alerts,
  status,
  loading,
  onRefresh,
  postCostAnalytics,
}: BudgetSectionProps) {
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newLimit, setNewLimit] = useState('')
  const [creating, setCreating] = useState(false)

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 items-center">
          <Text className="text-xs text-muted-foreground">Loading…</Text>
        </CardContent>
      </Card>
    )
  }

  const handleCreate = async () => {
    const limit = parseFloat(newLimit)
    if (!newName.trim() || isNaN(limit) || limit <= 0) return
    setCreating(true)
    try {
      await postCostAnalytics('budget-alerts', { name: newName.trim(), creditLimit: limit })
      setNewName('')
      setNewLimit('')
      setShowCreate(false)
      onRefresh()
    } catch { /* handled */ }
    setCreating(false)
  }

  return (
    <View className="gap-3">
      {status?.throttleModel && (
        <Card>
          <CardContent className="p-3 bg-amber-500/5 border-amber-500/20">
            <View className="flex-row items-center gap-2">
              <Bell size={14} className="text-amber-400" />
              <Text className="text-xs font-medium text-amber-400">
                Auto-throttle active — model limited to {getModelDisplayName(status.throttleModel)}
              </Text>
            </View>
          </CardContent>
        </Card>
      )}

      {(alerts ?? []).length === 0 ? (
        <Card>
          <CardContent className="p-6 items-center">
            <Bell size={24} className="text-muted-foreground mb-2" />
            <Text className="text-sm font-medium text-foreground mb-1">No budget alerts</Text>
            <Text className="text-xs text-muted-foreground text-center max-w-[280px] mb-3">
              Set spending limits and get notified when costs approach thresholds. Optionally auto-throttle to cheaper models.
            </Text>
            <Button variant="outline" onPress={() => setShowCreate(true)}>
              <View className="flex-row items-center gap-1.5">
                <Plus size={12} className="text-foreground" />
                <Text className="text-sm font-medium text-foreground">Create Alert</Text>
              </View>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {(alerts ?? []).map(alert => {
            const usageInfo = (status?.usage ?? status?.breached ?? []).find(b => b.alert.id === alert.id)
            const isBreached = usageInfo && usageInfo.percentUsed >= 100
            const isWarning = usageInfo && usageInfo.percentUsed >= 80 && !isBreached

            return (
              <Card key={alert.id}>
                <CardContent className={cn(
                  'p-3',
                  isBreached ? 'border-red-500/30' : isWarning ? 'border-amber-500/30' : '',
                )}>
                  <View className="flex-row items-center justify-between mb-2">
                    <View className="flex-row items-center gap-2">
                      <Bell size={14} className={isBreached ? 'text-red-400' : isWarning ? 'text-amber-400' : 'text-muted-foreground'} />
                      <Text className="text-sm font-semibold text-foreground">{alert.name}</Text>
                    </View>
                    <View className={cn(
                      'px-1.5 py-0.5 rounded',
                      alert.enabled ? 'bg-green-500/15' : 'bg-muted',
                    )}>
                      <Text className={cn('text-[9px] font-medium', alert.enabled ? 'text-green-400' : 'text-muted-foreground')}>
                        {alert.enabled ? 'Active' : 'Disabled'}
                      </Text>
                    </View>
                  </View>

                  <View className="flex-row items-baseline gap-1 mb-1">
                    <Text className="text-lg font-bold text-foreground">
                      {formatDollarCost(usageInfo?.currentSpend ?? 0)}
                    </Text>
                    <Text className="text-xs text-muted-foreground">
                      / {formatDollarCost(alert.creditLimit)} ({alert.periodType})
                    </Text>
                  </View>

                  <View className="h-2 bg-muted rounded-full overflow-hidden mb-2">
                    <View
                      className={cn(
                        'h-full rounded-full',
                        isBreached ? 'bg-red-500' : isWarning ? 'bg-amber-500' : 'bg-primary',
                      )}
                      style={{ width: `${Math.min(usageInfo?.percentUsed ?? 0, 100)}%` }}
                    />
                  </View>

                  <View className="flex-row items-center gap-3">
                    {alert.autoThrottle && (
                      <Text className="text-[10px] text-muted-foreground">
                        Auto-throttle to {alert.throttleToModel ? getModelDisplayName(alert.throttleToModel) : 'economy'}
                      </Text>
                    )}
                  </View>
                </CardContent>
              </Card>
            )
          })}

          <Button variant="outline" onPress={() => setShowCreate(true)}>
            <View className="flex-row items-center gap-1.5">
              <Plus size={12} className="text-foreground" />
              <Text className="text-sm font-medium text-foreground">Add Alert</Text>
            </View>
          </Button>
        </>
      )}

      {showCreate && (
        <Card>
          <CardContent className="p-3 gap-3">
            <Text className="text-sm font-semibold text-foreground">New Budget Alert</Text>
            <TextInput
              className="h-9 px-3 rounded-lg border border-border bg-background text-sm text-foreground"
              placeholder="Alert name (e.g. Monthly spend cap)"
              placeholderTextColor="#888"
              value={newName}
              onChangeText={setNewName}
            />
            <TextInput
              className="h-9 px-3 rounded-lg border border-border bg-background text-sm text-foreground"
              placeholder="USD limit (e.g. 25)"
              placeholderTextColor="#888"
              value={newLimit}
              onChangeText={setNewLimit}
              keyboardType="numeric"
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
