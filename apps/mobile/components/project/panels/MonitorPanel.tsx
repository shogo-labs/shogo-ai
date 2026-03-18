// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { StatusPanel } from './StatusPanel'
import { AnalyticsPanel } from './AnalyticsPanel'
import { LogsPanel } from './LogsPanel'

type SubTab = 'overview' | 'analytics' | 'logs'

interface MonitorPanelProps {
  projectId: string
  agentUrl: string | null
  visible: boolean
  isPaidPlan?: boolean
}

export function MonitorPanel({ projectId, agentUrl, visible, isPaidPlan }: MonitorPanelProps) {
  const [subTab, setSubTab] = useState<SubTab>('overview')

  if (!visible) return null

  return (
    <View className="absolute inset-0 flex-col" style={{ display: visible ? 'flex' : 'none' }}>
      {/* Sub-tab toggle */}
      <View className="px-4 py-2 border-b border-border flex-row items-center gap-2">
        <View className="flex-row rounded-md border border-border" accessibilityRole="tablist">
          {([
            { id: 'overview' as SubTab, label: 'Overview' },
            { id: 'analytics' as SubTab, label: 'Analytics' },
            { id: 'logs' as SubTab, label: 'Logs' },
          ]).map((tab) => (
            <Pressable
              key={tab.id}
              onPress={() => setSubTab(tab.id)}
              accessibilityRole="tab"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected: subTab === tab.id }}
              className={cn(
                'px-3 py-1.5 rounded-md',
                subTab === tab.id ? 'bg-primary' : 'active:bg-muted',
              )}
            >
              <Text
                className={cn(
                  'text-xs font-medium',
                  subTab === tab.id ? 'text-primary-foreground' : 'text-muted-foreground',
                )}
              >
                {tab.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Sub-panel content */}
      <View className="flex-1 relative">
        <StatusPanel projectId={projectId} agentUrl={agentUrl} visible={subTab === 'overview'} isPaidPlan={isPaidPlan} />
        <AnalyticsPanel projectId={projectId} agentUrl={agentUrl} visible={subTab === 'analytics'} />
        <LogsPanel projectId={projectId} agentUrl={agentUrl} visible={subTab === 'logs'} />
      </View>
    </View>
  )
}
