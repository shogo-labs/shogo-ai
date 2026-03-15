// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Switch } from '@/components/ui/switch'
import { SkillsPanel } from './SkillsPanel'
import { ToolsPanel } from './ToolsPanel'
// import { ServicesPanel } from './ServicesPanel'

type SubTab = 'skills' | 'tools' /* | 'services' */

interface CapabilitiesPanelProps {
  projectId: string
  agentUrl: string | null
  visible: boolean
  canvasEnabled: boolean
  onCanvasToggle: (enabled: boolean) => void
}

export function CapabilitiesPanel({ projectId, agentUrl, visible, canvasEnabled, onCanvasToggle }: CapabilitiesPanelProps) {
  const [subTab, setSubTab] = useState<SubTab>('skills')

  if (!visible) return null

  return (
    <View className="absolute inset-0 flex-col" style={{ display: visible ? 'flex' : 'none' }}>
      {/* Canvas toggle */}
      <View className="px-4 py-3 border-b border-border flex-row items-center justify-between">
        <View>
          <Text className="text-sm font-medium text-foreground">Canvas</Text>
          <Text className="text-xs text-muted-foreground">
            {canvasEnabled ? 'Agent can build visual dashboards' : 'Chat-only mode'}
          </Text>
        </View>
        <Switch
          value={canvasEnabled}
          onValueChange={onCanvasToggle}
          size="sm"
        />
      </View>

      {/* Sub-tab toggle */}
      <View className="px-4 py-2 border-b border-border flex-row items-center gap-2">
        <View className="flex-row rounded-md border border-border">
          {([
            { id: 'skills' as SubTab, label: 'Skills' },
            { id: 'tools' as SubTab, label: 'Tools' },
            // { id: 'services' as SubTab, label: 'Services' },
          ]).map((tab) => (
            <Pressable
              key={tab.id}
              onPress={() => setSubTab(tab.id)}
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
        <SkillsPanel projectId={projectId} agentUrl={agentUrl} visible={subTab === 'skills'} />
        <ToolsPanel projectId={projectId} agentUrl={agentUrl} visible={subTab === 'tools'} />
        {/* <ServicesPanel projectId={projectId} agentUrl={agentUrl} visible={subTab === 'services'} /> */}
      </View>
    </View>
  )
}
