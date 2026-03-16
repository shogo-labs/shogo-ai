// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useCallback } from 'react'
import { View, Text, Pressable, ScrollView } from 'react-native'
import {
  LayoutDashboard,
  Globe,
  Terminal,
  Clock,
  ImageIcon,
  Brain,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Switch } from '@/components/ui/switch'
import { SkillsPanel } from './SkillsPanel'
import { ToolsPanel } from './ToolsPanel'

export interface CapabilitySettings {
  canvasEnabled: boolean
  webEnabled: boolean
  shellEnabled: boolean
  cronEnabled: boolean
  imageGenEnabled: boolean
  memoryEnabled: boolean
}

interface CapabilityDef {
  key: keyof CapabilitySettings
  label: string
  description: string
  disabledDescription: string
  icon: typeof LayoutDashboard
  toolNames: string[]
  warning?: string
}

const CAPABILITIES: CapabilityDef[] = [
  {
    key: 'canvasEnabled',
    label: 'Canvas',
    description: 'Build interactive visual dashboards and apps',
    disabledDescription: 'Chat-only mode — no visual UI',
    icon: LayoutDashboard,
    toolNames: [
      'canvas_create', 'canvas_update', 'canvas_data', 'canvas_data_patch',
      'canvas_delete', 'canvas_action_wait', 'canvas_components',
      'canvas_api_schema', 'canvas_api_seed', 'canvas_api_query',
      'canvas_api_hooks', 'canvas_api_bind', 'canvas_trigger_action', 'canvas_inspect',
    ],
  },
  {
    key: 'webEnabled',
    label: 'Web Access',
    description: 'Search the web and browse pages',
    disabledDescription: 'No internet access',
    icon: Globe,
    toolNames: ['web', 'browser'],
  },
  {
    key: 'shellEnabled',
    label: 'Shell',
    description: 'Execute code and system commands',
    disabledDescription: 'No code execution',
    icon: Terminal,
    toolNames: ['exec'],
    warning: 'Disabling this prevents the agent from running any code or commands.',
  },
  {
    key: 'cronEnabled',
    label: 'Scheduling',
    description: 'Run tasks automatically on a schedule',
    disabledDescription: 'No autonomous scheduling',
    icon: Clock,
    toolNames: ['cron'],
  },
  {
    key: 'imageGenEnabled',
    label: 'Image Generation',
    description: 'Generate images from text descriptions',
    disabledDescription: 'No image generation',
    icon: ImageIcon,
    toolNames: ['generate_image'],
  },
  {
    key: 'memoryEnabled',
    label: 'Memory',
    description: 'Remember information across conversations',
    disabledDescription: 'Ephemeral — no long-term memory',
    icon: Brain,
    toolNames: ['memory_read', 'memory_write', 'memory_search'],
    warning: 'Disabling this means the agent cannot recall past conversations.',
  },
]

type SubTab = 'built-in' | 'skills' | 'integrations'

interface CapabilitiesPanelProps {
  projectId: string
  agentUrl: string | null
  visible: boolean
  capabilities: CapabilitySettings
  onCapabilityToggle: (key: string, enabled: boolean) => void
}

export function CapabilitiesPanel({
  projectId,
  agentUrl,
  visible,
  capabilities,
  onCapabilityToggle,
}: CapabilitiesPanelProps) {
  const [subTab, setSubTab] = useState<SubTab>('built-in')
  const [expandedCap, setExpandedCap] = useState<string | null>(null)
  const [pendingToggle, setPendingToggle] = useState<{ key: string; enabled: boolean } | null>(null)

  const handleToggle = useCallback((cap: CapabilityDef, enabled: boolean) => {
    if (!enabled && cap.warning) {
      setPendingToggle({ key: cap.key, enabled })
      return
    }
    onCapabilityToggle(cap.key, enabled)
  }, [onCapabilityToggle])

  const confirmToggle = useCallback(() => {
    if (pendingToggle) {
      onCapabilityToggle(pendingToggle.key, pendingToggle.enabled)
      setPendingToggle(null)
    }
  }, [pendingToggle, onCapabilityToggle])

  if (!visible) return null

  const enabledCount = Object.values(capabilities).filter(Boolean).length

  const TABS: { id: SubTab; label: string }[] = [
    { id: 'built-in', label: `Built-in (${enabledCount}/${CAPABILITIES.length})` },
    { id: 'skills', label: 'Skills' },
    { id: 'integrations', label: 'Integrations' },
  ]

  return (
    <View className="absolute inset-0 flex-col" style={{ display: visible ? 'flex' : 'none' }}>
      {/* Tab bar */}
      <View className="px-4 py-2.5 border-b border-border flex-row items-center">
        <View className="flex-row rounded-md border border-border">
          {TABS.map((tab) => (
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

      {/* Built-in capabilities tab */}
      {subTab === 'built-in' && (
        <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 24 }}>
          <View className="px-4 gap-2 pt-3">
            {CAPABILITIES.map((cap) => {
              const enabled = capabilities[cap.key]
              const isExpanded = expandedCap === cap.key
              const Icon = cap.icon

              return (
                <View
                  key={cap.key}
                  className={cn(
                    'border rounded-lg overflow-hidden',
                    enabled ? 'border-border' : 'border-border/50',
                  )}
                >
                  <View className={cn(
                    'px-3 py-2.5 flex-row items-center gap-3',
                    !enabled && 'opacity-60',
                  )}>
                    <Pressable
                      onPress={() => setExpandedCap(isExpanded ? null : cap.key)}
                      className="flex-row items-center gap-3 flex-1"
                    >
                      <View className={cn(
                        'w-8 h-8 rounded-md items-center justify-center',
                        enabled ? 'bg-primary/10' : 'bg-muted',
                      )}>
                        <Icon size={15} className={enabled ? 'text-primary' : 'text-muted-foreground'} />
                      </View>
                      <View className="flex-1">
                        <View className="flex-row items-center gap-2">
                          <Text className="text-sm font-medium text-foreground">{cap.label}</Text>
                          <Text className="text-[10px] text-muted-foreground">
                            {cap.toolNames.length} tool{cap.toolNames.length !== 1 ? 's' : ''}
                          </Text>
                        </View>
                        <Text className="text-xs text-muted-foreground mt-0.5">
                          {enabled ? cap.description : cap.disabledDescription}
                        </Text>
                      </View>
                      {isExpanded ? (
                        <ChevronDown size={14} className="text-muted-foreground" />
                      ) : (
                        <ChevronRight size={14} className="text-muted-foreground" />
                      )}
                    </Pressable>
                    <Switch
                      value={enabled}
                      onValueChange={(v) => handleToggle(cap, v)}
                      size="sm"
                    />
                  </View>

                  {isExpanded && (
                    <View className="px-3 pb-3 pt-1 border-t border-border ml-11">
                      <Text className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                        Tools in this group
                      </Text>
                      <View className="flex-row flex-wrap gap-1">
                        {cap.toolNames.map((name) => (
                          <View key={name} className="px-2 py-0.5 bg-muted rounded-md">
                            <Text className="text-[10px] text-muted-foreground font-mono">{name}</Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  )}
                </View>
              )
            })}
          </View>

          {/* Confirmation dialog for dangerous toggles */}
          {pendingToggle && (
            <View className="mx-4 mt-3 border border-orange-400/50 bg-orange-50/50 dark:bg-orange-900/10 rounded-lg p-3">
              <View className="flex-row items-start gap-2">
                <AlertTriangle size={14} className="text-orange-500 mt-0.5" />
                <View className="flex-1">
                  <Text className="text-sm font-medium text-foreground mb-1">
                    Disable {CAPABILITIES.find(c => c.key === pendingToggle.key)?.label}?
                  </Text>
                  <Text className="text-xs text-muted-foreground mb-3">
                    {CAPABILITIES.find(c => c.key === pendingToggle.key)?.warning}
                  </Text>
                  <View className="flex-row gap-2">
                    <Pressable
                      onPress={confirmToggle}
                      className="px-3 py-1.5 bg-orange-500 rounded-md active:bg-orange-600"
                    >
                      <Text className="text-xs font-medium text-white">Disable</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => setPendingToggle(null)}
                      className="px-3 py-1.5 border border-border rounded-md active:bg-muted"
                    >
                      <Text className="text-xs font-medium text-foreground">Cancel</Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            </View>
          )}
        </ScrollView>
      )}

      {/* Skills tab */}
      {subTab === 'skills' && (
        <View className="flex-1 relative">
          <SkillsPanel projectId={projectId} agentUrl={agentUrl} visible />
        </View>
      )}

      {/* Integrations tab */}
      {subTab === 'integrations' && (
        <View className="flex-1 relative">
          <ToolsPanel projectId={projectId} agentUrl={agentUrl} visible />
        </View>
      )}
    </View>
  )
}
