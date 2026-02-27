import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  TextInput,
  Linking,
  Platform,
} from 'react-native'
import { Server, RefreshCw, ChevronDown, ChevronRight, Key, Link2, CheckCircle2 } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Switch } from '@/components/ui/switch'
import { API_URL, api } from '../../../lib/api'
import { useDomainHttp } from '../../../contexts/domain'

interface MCPCatalogEntry {
  id: string
  name: string
  description: string
  category: string
  package: string
  requiredEnv: Record<string, string>
  optionalEnv?: Record<string, string>
  providedTools: string[]
  icon: string
  cloudCompatible: boolean
  authType?: 'composio' | 'api_key' | 'none'
  composioToolkit?: string
}

interface CategoryMeta {
  label: string
  icon: string
}

interface MCPServersPanelProps {
  projectId: string
  agentUrl: string | null
  visible: boolean
}

export function MCPServersPanel({ projectId, agentUrl, visible }: MCPServersPanelProps) {
  const http = useDomainHttp()
  const [catalog, setCatalog] = useState<MCPCatalogEntry[]>([])
  const [categories, setCategories] = useState<Record<string, CategoryMeta>>({})
  const [enabledServers, setEnabledServers] = useState<Record<string, any>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [toggling, setToggling] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null)
  const [envInputs, setEnvInputs] = useState<Record<string, Record<string, string>>>({})
  const [showEnvForm, setShowEnvForm] = useState<string | null>(null)
  const [composioConnections, setComposioConnections] = useState<Record<string, boolean>>({})
  const [connecting, setConnecting] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    if (!agentUrl) return
    setIsLoading(true)
    setError(null)
    try {
      const [catalogRes, statusRes] = await Promise.all([
        fetch(`${agentUrl}/agent/mcp-catalog`),
        fetch(`${agentUrl}/agent/status`),
      ])
      if (!catalogRes.ok) throw new Error('Failed to load MCP catalog')
      const catalogData = await catalogRes.json()
      setCatalog(catalogData.catalog || [])
      setCategories(catalogData.categories || {})

      if (statusRes.ok) {
        const configRes = await fetch(`${agentUrl}/agent/files/config.json`)
        if (configRes.ok) {
          const configData = await configRes.json()
          try {
            const config = JSON.parse(configData.content || '{}')
            setEnabledServers(config.mcpServers || {})
          } catch {
            setEnabledServers({})
          }
        }
      }

      try {
        const connections = await api.getIntegrationConnections(http, projectId)
        const connMap: Record<string, boolean> = {}
        for (const conn of connections) {
          connMap[conn.toolkit?.toLowerCase() ?? ''] = conn.status === 'active'
        }
        setComposioConnections(connMap)
      } catch {
        // Composio status check is non-critical
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }, [agentUrl, http, projectId])

  useEffect(() => {
    if (visible) loadData()
  }, [visible, loadData])

  const handleToggle = useCallback(
    async (entry: MCPCatalogEntry) => {
      if (!agentUrl) return
      const isEnabled = entry.id in enabledServers
      const needsEnv = !isEnabled && Object.keys(entry.requiredEnv).length > 0

      if (needsEnv) {
        const currentEnvs = envInputs[entry.id] || {}
        const allFilled = Object.keys(entry.requiredEnv).every((k) => currentEnvs[k]?.trim())
        if (!allFilled) {
          setShowEnvForm(entry.id)
          return
        }
      }

      setToggling(entry.id)
      try {
        const env = envInputs[entry.id] || {}
        const res = await fetch(`${agentUrl}/agent/mcp-servers/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            serverId: entry.id,
            enabled: !isEnabled,
            env: Object.keys(env).length > 0 ? env : undefined,
          }),
        })
        if (!res.ok) {
          const data = await res.json()
          throw new Error(data.error || 'Failed to toggle server')
        }
        const data = await res.json()
        setEnabledServers(data.servers || {})
        setShowEnvForm(null)
      } catch (err: any) {
        setError(err.message)
      } finally {
        setToggling(null)
      }
    },
    [agentUrl, enabledServers, envInputs],
  )

  const handleComposioConnect = useCallback(
    async (entry: MCPCatalogEntry) => {
      if (!entry.composioToolkit) return
      setConnecting(entry.id)
      setError(null)
      try {
        const callbackUrl = `${API_URL}/api/integrations/callback`
        const data = await api.connectIntegration(http, entry.composioToolkit, projectId, callbackUrl)
        const redirectUrl = data.data?.redirectUrl
        if (redirectUrl) {
          if (Platform.OS === 'web') {
            const popup = window.open(redirectUrl, 'composio-connect', 'width=600,height=700,popup=yes')
            const checkInterval = setInterval(() => {
              if (popup?.closed) {
                clearInterval(checkInterval)
                setConnecting(null)
                loadData()
              }
            }, 500)
            setTimeout(() => {
              clearInterval(checkInterval)
              setConnecting(null)
              loadData()
            }, 120_000)
          } else {
            await Linking.openURL(redirectUrl)
            setTimeout(() => {
              setConnecting(null)
              loadData()
            }, 5000)
          }
        }
      } catch (err: any) {
        setError(err.message)
        setConnecting(null)
      }
    },
    [http, projectId, loadData],
  )

  const handleComposioDisconnect = useCallback(
    async (entry: MCPCatalogEntry) => {
      if (!entry.composioToolkit) return
      setConnecting(entry.id)
      try {
        const statusData = await api.getIntegrationStatus(http, entry.composioToolkit, projectId)
        const connectionId = statusData.data?.connectionId
        if (connectionId) {
          await api.disconnectIntegration(http, connectionId)
        }
        setComposioConnections((prev) => {
          const next = { ...prev }
          delete next[entry.composioToolkit!.toLowerCase()]
          return next
        })
      } catch (err: any) {
        setError(err.message)
      } finally {
        setConnecting(null)
      }
    },
    [http, projectId],
  )

  const grouped = useMemo(() => {
    const groups: Record<string, MCPCatalogEntry[]> = {}
    for (const entry of catalog) {
      if (!groups[entry.category]) groups[entry.category] = []
      groups[entry.category].push(entry)
    }
    return groups
  }, [catalog])

  if (!visible) return null

  const enabledCount = Object.keys(enabledServers).length

  return (
    <View className="absolute inset-0 flex-col">
      <View className="px-4 py-3 border-b border-border flex-row items-center gap-2">
        <Server size={16} className="text-muted-foreground" />
        <Text className="text-sm font-medium text-foreground">MCP Servers</Text>
        <Text className="text-xs text-muted-foreground">{enabledCount} enabled</Text>
        <Pressable onPress={loadData} className="ml-auto p-1 rounded-md active:bg-muted">
          <RefreshCw size={14} className="text-muted-foreground" />
        </Pressable>
      </View>

      {error && (
        <View className="px-4 py-2 bg-destructive/10">
          <Text className="text-xs text-destructive">{error}</Text>
        </View>
      )}

      <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
        {isLoading ? (
          <View className="items-center py-8">
            <ActivityIndicator size="small" />
            <Text className="text-sm text-muted-foreground mt-2">Loading catalog...</Text>
          </View>
        ) : (
          <View className="gap-3">
            <Text className="text-xs text-muted-foreground">
              Toggle MCP servers to give your agent additional capabilities.
            </Text>

            {Object.entries(grouped).map(([categoryId, entries]) => {
              const catMeta = categories[categoryId] || { label: categoryId, icon: '📦' }
              const isExpanded = expandedCategory === categoryId || expandedCategory === null
              const enabledInCategory = entries.filter((e) => e.id in enabledServers).length

              return (
                <View key={categoryId} className="border border-border rounded-lg overflow-hidden">
                  <Pressable
                    onPress={() =>
                      setExpandedCategory(
                        isExpanded && expandedCategory !== null ? null : categoryId,
                      )
                    }
                    className="px-3 py-2 flex-row items-center gap-2 active:bg-muted/50"
                  >
                    <Text className="text-sm text-foreground">{catMeta.icon}</Text>
                    <Text className="text-xs font-medium text-foreground flex-1">
                      {catMeta.label}
                    </Text>
                    {enabledInCategory > 0 && (
                      <View className="px-1.5 py-0.5 rounded-full bg-primary/10">
                        <Text className="text-[10px] text-primary font-medium">
                          {enabledInCategory} active
                        </Text>
                      </View>
                    )}
                    {isExpanded ? (
                      <ChevronDown size={12} className="text-muted-foreground" />
                    ) : (
                      <ChevronRight size={12} className="text-muted-foreground" />
                    )}
                  </Pressable>

                  {isExpanded && (
                    <View className="border-t border-border">
                      {entries.map((entry) => {
                        const isEnabled = entry.id in enabledServers
                        const isToggling = toggling === entry.id
                        const showingEnv = showEnvForm === entry.id
                        const isComposio = entry.authType === 'composio'
                        const isComposioConnected = isComposio && entry.composioToolkit
                          ? !!composioConnections[entry.composioToolkit.toLowerCase()]
                          : false
                        const isConnecting = connecting === entry.id

                        return (
                          <View
                            key={entry.id}
                            className="border-b border-border last:border-b-0"
                          >
                            <View className="px-3 py-2.5 flex-row items-start gap-3">
                              <Text className="text-lg text-foreground mt-0.5">{entry.icon}</Text>
                              <View className="flex-1">
                                <View className="flex-row items-center gap-2">
                                  <Text className="text-sm font-medium text-foreground">
                                    {entry.name}
                                  </Text>
                                  {!entry.cloudCompatible && (
                                    <View className="px-1 py-0.5 rounded bg-amber-500/10">
                                      <Text className="text-[10px] text-amber-600">
                                        Desktop only
                                      </Text>
                                    </View>
                                  )}
                                  {isComposioConnected && (
                                    <View className="px-1.5 py-0.5 rounded-full bg-green-500/10 flex-row items-center gap-1">
                                      <CheckCircle2 size={10} color="#22c55e" />
                                      <Text className="text-[10px] text-green-600 font-medium">
                                        Connected
                                      </Text>
                                    </View>
                                  )}
                                </View>
                                <Text className="text-xs text-muted-foreground mt-0.5">
                                  {entry.description}
                                </Text>
                                <View className="flex-row flex-wrap gap-1 mt-1.5">
                                  {entry.providedTools.slice(0, 4).map((tool) => (
                                    <View key={tool} className="px-1.5 py-0.5 bg-muted rounded">
                                      <Text className="text-muted-foreground text-[10px]">
                                        {tool}
                                      </Text>
                                    </View>
                                  ))}
                                  {entry.providedTools.length > 4 && (
                                    <Text className="text-[10px] text-muted-foreground">
                                      +{entry.providedTools.length - 4} more
                                    </Text>
                                  )}
                                </View>
                                {!isComposio && Object.keys(entry.requiredEnv).length > 0 && !isEnabled && (
                                  <View className="flex-row items-center gap-1 mt-1.5">
                                    <Key size={10} className="text-muted-foreground" />
                                    <Text className="text-[10px] text-muted-foreground">
                                      Requires: {Object.keys(entry.requiredEnv).join(', ')}
                                    </Text>
                                  </View>
                                )}
                              </View>

                              {/* Composio OAuth: Connect/Disconnect button */}
                              {isComposio ? (
                                <Pressable
                                  onPress={() =>
                                    isComposioConnected
                                      ? handleComposioDisconnect(entry)
                                      : handleComposioConnect(entry)
                                  }
                                  disabled={isConnecting}
                                  className={cn(
                                    'mt-1 px-3 py-1.5 rounded-md',
                                    isComposioConnected
                                      ? 'border border-border active:bg-muted'
                                      : 'bg-primary active:bg-primary/80',
                                    isConnecting && 'opacity-50',
                                  )}
                                >
                                  {isConnecting ? (
                                    <ActivityIndicator size="small" color={isComposioConnected ? '#666' : '#fff'} />
                                  ) : (
                                    <View className="flex-row items-center gap-1.5">
                                      <Link2 size={12} color={isComposioConnected ? '#666' : '#fff'} />
                                      <Text
                                        className={cn(
                                          'text-xs font-medium',
                                          isComposioConnected ? 'text-foreground' : 'text-primary-foreground',
                                        )}
                                      >
                                        {isComposioConnected ? 'Disconnect' : 'Connect'}
                                      </Text>
                                    </View>
                                  )}
                                </Pressable>
                              ) : (
                                <Switch
                                  value={isEnabled}
                                  onValueChange={() => handleToggle(entry)}
                                  disabled={isToggling}
                                  trackColor={{ false: '#d1d5db', true: '#3b82f6' }}
                                  className={cn('mt-1', isToggling && 'opacity-50')}
                                />
                              )}
                            </View>

                            {showingEnv && !isComposio && (
                              <View className="px-3 pb-3 ml-9">
                                <View className="border border-border rounded-md p-3 bg-muted/30 gap-2">
                                  <Text className="text-xs font-medium text-foreground">
                                    Required credentials
                                  </Text>
                                  {Object.entries(entry.requiredEnv).map(([key, desc]) => (
                                    <View key={key}>
                                      <Text className="text-[10px] text-muted-foreground mb-0.5">
                                        {key}
                                      </Text>
                                      <TextInput
                                        secureTextEntry
                                        placeholder={desc}
                                        placeholderTextColor="#666"
                                        value={envInputs[entry.id]?.[key] || ''}
                                        onChangeText={(text) =>
                                          setEnvInputs((prev) => ({
                                            ...prev,
                                            [entry.id]: { ...prev[entry.id], [key]: text },
                                          }))
                                        }
                                        className="px-2 py-1 text-xs border border-border rounded bg-background text-foreground"
                                      />
                                    </View>
                                  ))}
                                  <View className="flex-row gap-2 mt-2">
                                    <Pressable
                                      onPress={() => handleToggle(entry)}
                                      className="px-3 py-1 bg-primary rounded-md active:bg-primary/80"
                                    >
                                      <Text className="text-xs text-primary-foreground">
                                        Enable
                                      </Text>
                                    </Pressable>
                                    <Pressable
                                      onPress={() => setShowEnvForm(null)}
                                      className="px-3 py-1 border border-border rounded-md active:bg-muted"
                                    >
                                      <Text className="text-xs text-foreground">Cancel</Text>
                                    </Pressable>
                                  </View>
                                </View>
                              </View>
                            )}
                          </View>
                        )
                      })}
                    </View>
                  )}
                </View>
              )
            })}
          </View>
        )}
      </ScrollView>
    </View>
  )
}
