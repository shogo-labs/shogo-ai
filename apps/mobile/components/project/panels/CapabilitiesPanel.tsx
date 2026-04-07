// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useCallback, useEffect, useRef } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native'
import {
  Globe,
  Monitor,
  Terminal,
  Clock,
  ImageIcon,
  Brain,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Cpu,
  Check,
  Lock,
  MessageSquare,
  LayoutDashboard,
  Code,
  Eye,
  EyeOff,
  Save,
  Zap,
  Layers,
  Settings,
} from 'lucide-react-native'
import { TextInput } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { usePlatformConfig } from '../../../lib/platform-config'
import { Switch } from '@/components/ui/switch'
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from '@/components/ui/popover'
import { agentFetch } from '../../../lib/agent-fetch'
import { getAvailableModels, getModelsByProvider, type ModelTier } from '@shogo/model-catalog'
import { SkillsPanel } from './SkillsPanel'
import { ToolsPanel } from './ToolsPanel'
import { api, createHttpClient, type TechStackSummary } from '../../../lib/api'

export interface CapabilitySettings {
  canvasEnabled: boolean
  webEnabled: boolean
  browserEnabled: boolean
  shellEnabled: boolean
  heartbeatEnabled: boolean
  imageGenEnabled: boolean
  memoryEnabled: boolean
  quickActionsEnabled: boolean
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

type AgentMode = 'none' | 'canvas'

const AGENT_TYPES: { mode: AgentMode; label: string; description: string; icon: typeof MessageSquare }[] = [
  { mode: 'none', label: 'Chat', description: 'Chat-only agent', icon: MessageSquare },
  { mode: 'canvas', label: 'Canvas', description: 'Visual dashboards', icon: LayoutDashboard },
  // APP_MODE_DISABLED: { mode: 'app', label: 'App', description: 'Full-stack apps', icon: Code },
]

const CAPABILITIES: CapabilityDef[] = [
  {
    key: 'webEnabled',
    label: 'Web Search',
    description: 'Search the web and fetch pages',
    disabledDescription: 'No internet search access',
    icon: Globe,
    toolNames: ['web'],
  },
  {
    key: 'browserEnabled',
    label: 'Browser Control',
    description: 'Navigate and interact with web pages',
    disabledDescription: 'No browser automation',
    icon: Monitor,
    toolNames: ['browser'],
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
    key: 'heartbeatEnabled',
    label: 'Heartbeat',
    description: 'Periodic autonomous check-ins on a schedule',
    disabledDescription: 'No autonomous scheduling',
    icon: Clock,
    toolNames: ['heartbeat_configure', 'heartbeat_status'],
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
  {
    key: 'quickActionsEnabled',
    label: 'Quick Actions',
    description: 'Register and suggest repeatable prompt shortcuts',
    disabledDescription: 'No prompt shortcuts',
    icon: Zap,
    toolNames: ['quick_action'],
  },
]

interface ModelOption {
  provider: string
  name: string
  displayName: string
  tier: ModelTier
}

const AVAILABLE_MODELS: ModelOption[] = getAvailableModels({ generation: 'current' }).map(e => ({
  provider: e.provider,
  name: e.id,
  displayName: e.displayName,
  tier: e.tier,
}))

const MODEL_GROUPS = getModelsByProvider().map(g => ({
  label: g.label,
  models: g.models.map(e => ({
    provider: e.provider,
    name: e.id,
    displayName: e.displayName,
    tier: e.tier,
  })),
}))

const TIER_LABELS: Record<ModelTier, string> = {
  premium: 'Premium',
  standard: 'Standard',
  economy: 'Economy',
}

type SubTab = 'built-in' | 'skills' | 'integrations'

interface CapabilitiesPanelProps {
  projectId: string
  agentUrl: string | null
  visible: boolean
  capabilities: CapabilitySettings
  onCapabilityToggle: (key: string, enabled: boolean) => void
  isPaidPlan?: boolean
  activeMode?: AgentMode
  onModeChange?: (mode: AgentMode) => void
  techStackId?: string
  onTechStackChange?: (stackId: string, capabilities?: Record<string, boolean>) => void
}

export function CapabilitiesPanel({
  projectId,
  agentUrl,
  visible,
  capabilities,
  onCapabilityToggle,
  isPaidPlan,
  activeMode = 'none',
  onModeChange,
  techStackId,
  onTechStackChange,
}: CapabilitiesPanelProps) {
  const { localMode } = usePlatformConfig()
  const canSelectAllModels = localMode || isPaidPlan
  const [subTab, setSubTab] = useState<SubTab>('built-in')
  const [expandedCap, setExpandedCap] = useState<string | null>(null)
  const [pendingToggle, setPendingToggle] = useState<{ key: string; enabled: boolean } | null>(null)

  const [currentModel, setCurrentModel] = useState<{ provider: string; name: string } | null>(null)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [modelUpdating, setModelUpdating] = useState(false)
  const fetchedRef = useRef(false)

  const [extensionToken, setExtensionToken] = useState('')
  const [tokenVisible, setTokenVisible] = useState(false)
  const [tokenSaving, setTokenSaving] = useState(false)
  const [tokenSaved, setTokenSaved] = useState(false)
  const tokenFetchedRef = useRef(false)

  const [techStacks, setTechStacks] = useState<TechStackSummary[]>([])
  const [stackPickerOpen, setStackPickerOpen] = useState(false)
  const techStacksFetchedRef = useRef(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  useEffect(() => {
    if (!visible || !agentUrl || fetchedRef.current) return
    fetchedRef.current = true
    agentFetch(`${agentUrl}/agent/status`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.model) setCurrentModel(data.model)
      })
      .catch((e) => console.error('[CapabilitiesPanel] Failed to fetch model:', e))
  }, [visible, agentUrl])

  useEffect(() => {
    if (!visible || techStacksFetchedRef.current) return
    techStacksFetchedRef.current = true
    const http = createHttpClient()
    api.getTechStacks(http)
      .then(stacks => setTechStacks(stacks))
      .catch((e) => console.error('[CapabilitiesPanel] Failed to fetch tech stacks:', e))
  }, [visible])

  useEffect(() => {
    if (!visible || !agentUrl || tokenFetchedRef.current) return
    tokenFetchedRef.current = true
    agentFetch(`${agentUrl}/agent/config`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.browserExtensionToken) {
          setExtensionToken(data.browserExtensionToken)
          setTokenSaved(true)
        }
      })
      .catch(() => {})
  }, [visible, agentUrl])

  const handleSaveToken = useCallback(async () => {
    if (!agentUrl) return
    setTokenSaving(true)
    try {
      const res = await agentFetch(`${agentUrl}/agent/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ browserExtensionToken: extensionToken || null }),
      })
      if (res.ok) setTokenSaved(true)
    } catch (err) {
      console.error('[CapabilitiesPanel] Failed to save extension token:', err)
    } finally {
      setTokenSaving(false)
    }
  }, [agentUrl, extensionToken])

  const handleModelChange = useCallback(async (model: ModelOption) => {
    if (!agentUrl) return
    if (currentModel?.name === model.name && currentModel?.provider === model.provider) {
      setModelPickerOpen(false)
      return
    }
    setModelUpdating(true)
    try {
      const res = await agentFetch(`${agentUrl}/agent/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: { provider: model.provider, name: model.name } }),
      })
      if (res.ok) {
        setCurrentModel({ provider: model.provider, name: model.name })
      }
    } catch (err) {
      console.error('[CapabilitiesPanel] Failed to update model:', err)
    } finally {
      setModelUpdating(false)
      setModelPickerOpen(false)
    }
  }, [agentUrl, currentModel])

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

  const resolvedModel = AVAILABLE_MODELS.find(
    m => m.name === currentModel?.name || (currentModel?.name && m.name === currentModel.name.replace(/-\d{8}$/, ''))
  )

  const enabledCount = CAPABILITIES.filter(c => capabilities[c.key]).length

  const TABS: { id: SubTab; label: string }[] = [
    { id: 'built-in', label: 'Configuration' },
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
          {/* Agent type selector */}
          <View className="px-4 pt-3 pb-1">
            <Text className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Agent Type</Text>
            <View className="flex-row gap-2">
              {AGENT_TYPES.map(({ mode, label, description, icon: Icon }) => {
                const isActive = activeMode === mode
                return (
                  <Pressable
                    key={mode}
                    onPress={() => onModeChange?.(mode)}
                    className={cn(
                      'flex-1 border rounded-lg px-3 py-2.5 items-center gap-1.5',
                      isActive
                        ? 'border-primary bg-primary/10'
                        : 'border-border active:bg-muted',
                    )}
                  >
                    <Icon size={18} className={isActive ? 'text-primary' : 'text-muted-foreground'} />
                    <Text className={cn(
                      'text-xs font-semibold',
                      isActive ? 'text-primary' : 'text-foreground',
                    )}>
                      {label}
                    </Text>
                    <Text className="text-[10px] text-muted-foreground text-center">{description}</Text>
                  </Pressable>
                )
              })}
            </View>
          </View>

          {/* Tech Stack selector */}
          {techStacks.length > 0 && (
            <View className="px-4 pt-3 pb-1">
              <Text className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Tech Stack</Text>
              <View className="border border-border rounded-lg px-3 py-2.5 flex-row items-center gap-3">
                <View className="w-8 h-8 rounded-md items-center justify-center bg-primary/10">
                  <Layers size={15} className="text-primary" />
                </View>
                <View className="flex-1">
                  <Text className="text-xs text-muted-foreground">Stack</Text>
                  <Popover
                    placement="bottom left"
                    isOpen={stackPickerOpen}
                    onOpen={() => setStackPickerOpen(true)}
                    onClose={() => setStackPickerOpen(false)}
                    trigger={(triggerProps) => (
                      <Pressable
                        {...triggerProps}
                        onPress={() => setStackPickerOpen(prev => !prev)}
                        className="flex-row items-center gap-1.5 mt-0.5"
                      >
                        <Text className="text-sm font-medium text-foreground">
                          {techStacks.find(s => s.id === techStackId)?.name ?? 'None'}
                        </Text>
                        <ChevronDown size={14} className="text-muted-foreground" />
                      </Pressable>
                    )}
                  >
                    <PopoverBackdrop />
                    <PopoverContent className="w-72 bg-card border border-border rounded-xl shadow-lg">
                      <PopoverBody className="py-1">
                        {techStacks.map((stack) => {
                          const isSelected = stack.id === (techStackId ?? 'none')
                          return (
                            <Pressable
                              key={stack.id}
                              onPress={() => {
                                onTechStackChange?.(stack.id, stack.capabilities as Record<string, boolean> | undefined)
                                setStackPickerOpen(false)
                              }}
                              className={cn(
                                'px-3 py-2.5 flex-row items-center gap-3',
                                isSelected ? 'bg-primary/10' : 'active:bg-muted',
                              )}
                            >
                              <View className="flex-1">
                                <Text className={cn(
                                  'text-sm font-medium',
                                  isSelected ? 'text-primary' : 'text-foreground',
                                )}>
                                  {stack.name}
                                </Text>
                                <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
                                  {stack.description}
                                </Text>
                              </View>
                              {isSelected && <Check size={14} className="text-primary" />}
                            </Pressable>
                          )
                        })}
                      </PopoverBody>
                    </PopoverContent>
                  </Popover>
                </View>
              </View>
            </View>
          )}

          {/* Model selector */}
          <View className="px-4 pt-3 pb-1">
            <View className="border border-border rounded-lg px-3 py-2.5 flex-row items-center gap-3">
              <View className="w-8 h-8 rounded-md items-center justify-center bg-primary/10">
                <Cpu size={15} className="text-primary" />
              </View>
              <View className="flex-1">
                <Text className="text-xs text-muted-foreground">Model</Text>
                <Popover
                  placement="bottom left"
                  isOpen={modelPickerOpen}
                  onOpen={() => setModelPickerOpen(true)}
                  onClose={() => setModelPickerOpen(false)}
                  trigger={(triggerProps) => (
                    <Pressable
                      {...triggerProps}
                      onPress={() => setModelPickerOpen(prev => !prev)}
                      className="flex-row items-center gap-1.5 mt-0.5"
                      disabled={modelUpdating}
                    >
                      {modelUpdating ? (
                        <ActivityIndicator size="small" />
                      ) : (
                        <>
                          <Text className="text-sm font-medium text-foreground">
                            {resolvedModel?.displayName ?? currentModel?.name ?? 'Loading...'}
                          </Text>
                          <ChevronDown size={14} className="text-muted-foreground" />
                        </>
                      )}
                    </Pressable>
                  )}
                >
                  <PopoverBackdrop />
                  <PopoverContent className="p-0 min-w-[220px]">
                    <PopoverBody>
                      {MODEL_GROUPS.map((group) => (
                        <View key={group.label}>
                          <View className="px-3 pt-2.5 pb-1">
                            <Text className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                              {group.label}
                            </Text>
                          </View>
                          {group.models.map((model) => {
                            const isSelected = currentModel?.name === model.name
                              || (currentModel?.name && model.name === currentModel.name.replace(/-\d{8}$/, ''))
                            const isLocked = !canSelectAllModels && model.tier !== 'economy'
                            return (
                              <Pressable
                                key={model.name}
                                onPress={() => !isLocked && handleModelChange(model)}
                                className={cn(
                                  'flex-row items-center gap-2.5 px-3 py-2',
                                  isLocked ? 'opacity-50' : 'active:bg-muted',
                                  isSelected && !isLocked && 'bg-accent',
                                )}
                              >
                                <View className="flex-1">
                                  <Text className={cn('text-sm', isLocked ? 'text-muted-foreground' : 'text-foreground')}>{model.displayName}</Text>
                                </View>
                                {isLocked ? (
                                  <View className="flex-row items-center gap-1">
                                    <Lock size={10} className="text-muted-foreground" />
                                    <Text className="text-[10px] font-medium text-muted-foreground">Pro</Text>
                                  </View>
                                ) : (
                                  <>
                                    <Text className={cn(
                                      'text-[10px]',
                                      model.tier === 'premium' ? 'text-amber-500' :
                                      model.tier === 'economy' ? 'text-emerald-500' :
                                      'text-muted-foreground',
                                    )}>
                                      {TIER_LABELS[model.tier]}
                                    </Text>
                                    {isSelected && (
                                      <Check size={14} className="text-primary" />
                                    )}
                                  </>
                                )}
                              </Pressable>
                            )
                          })}
                        </View>
                      ))}
                    </PopoverBody>
                  </PopoverContent>
                </Popover>
              </View>
            </View>
          </View>

          {/* Advanced capabilities (collapsible) */}
          <View className="px-4 pt-4">
            <Pressable
              onPress={() => setAdvancedOpen(prev => !prev)}
              className="flex-row items-center gap-2 py-2"
            >
              <Settings size={14} className="text-muted-foreground" />
              <Text className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex-1">
                Advanced
              </Text>
              <Text className="text-[10px] text-muted-foreground mr-1">
                {enabledCount}/{CAPABILITIES.length} enabled
              </Text>
              {advancedOpen ? (
                <ChevronDown size={14} className="text-muted-foreground" />
              ) : (
                <ChevronRight size={14} className="text-muted-foreground" />
              )}
            </Pressable>

            {advancedOpen && (
              <View className="gap-2 pt-1">
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

                          {cap.key === 'browserEnabled' && (
                            <View className="mt-3 pt-2 border-t border-border/50">
                              <Text className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">
                                Browser Extension
                              </Text>
                              <Text className="text-[10px] text-muted-foreground mb-2">
                                Paste a Playwright extension token to control your real browser (with your logins and cookies). Without a token, a headless browser is used.
                              </Text>
                              <View className="flex-row items-center gap-2">
                                <View className="flex-1 flex-row items-center border border-border rounded-md bg-background">
                                  <TextInput
                                    value={extensionToken}
                                    onChangeText={(v) => { setExtensionToken(v.replace(/^\s*PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*/i, '').trim()); setTokenSaved(false) }}
                                    secureTextEntry={!tokenVisible}
                                    placeholder="Extension token..."
                                    placeholderTextColor="#999"
                                    className="flex-1 text-xs text-foreground px-2 py-1.5 font-mono"
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                  />
                                  <Pressable onPress={() => setTokenVisible(!tokenVisible)} className="px-2">
                                    {tokenVisible
                                      ? <EyeOff size={12} className="text-muted-foreground" />
                                      : <Eye size={12} className="text-muted-foreground" />}
                                  </Pressable>
                                </View>
                                <Pressable
                                  onPress={handleSaveToken}
                                  disabled={tokenSaving || tokenSaved}
                                  className={cn(
                                    'px-2.5 py-1.5 rounded-md flex-row items-center gap-1',
                                    tokenSaved ? 'bg-emerald-500/15' : 'bg-primary active:bg-primary/80',
                                    (tokenSaving || tokenSaved) && 'opacity-70',
                                  )}
                                >
                                  {tokenSaving ? (
                                    <ActivityIndicator size="small" />
                                  ) : tokenSaved ? (
                                    <Check size={12} className="text-emerald-600" />
                                  ) : (
                                    <Save size={12} className="text-primary-foreground" />
                                  )}
                                  <Text className={cn(
                                    'text-[10px] font-medium',
                                    tokenSaved ? 'text-emerald-600' : 'text-primary-foreground',
                                  )}>
                                    {tokenSaved ? 'Saved' : 'Save'}
                                  </Text>
                                </Pressable>
                              </View>
                              {extensionToken && tokenSaved && (
                                <Text className="text-[10px] text-emerald-600 mt-1">
                                  Extension mode active — using your real browser
                                </Text>
                              )}
                            </View>
                          )}
                        </View>
                      )}
                    </View>
                  )
                })}

                {/* Confirmation dialog for dangerous toggles */}
                {pendingToggle && (
                  <View className="mt-1 border border-orange-400/50 bg-orange-50/50 dark:bg-orange-900/10 rounded-lg p-3">
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
              </View>
            )}
          </View>
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
