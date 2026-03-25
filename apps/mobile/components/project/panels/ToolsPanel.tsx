// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  TextInput,
  Platform,
} from 'react-native'
import * as ExpoLinking from 'expo-linking'
import {
  Wrench,
  RefreshCw,
  Search,
  Trash2,
  Link2,
  CheckCircle2,
  Key,
  Download,
  X,
  AlertTriangle,
  ExternalLink,
  Loader2,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Tooltip, TooltipContent, TooltipText } from '@/components/ui/tooltip'
import { openAuthFlow, preCreateAuthWindow, isMobileWeb } from '@shogo/ui-kit/platform'
import { API_URL, api } from '../../../lib/api'

const LOG_PREFIX = '[ToolsPanel]'
import { useDomainHttp } from '../../../contexts/domain'
import { agentFetch } from '../../../lib/agent-fetch'

interface InstalledTool {
  id: string
  name: string
  source: 'managed' | 'catalog' | 'custom'
  status: 'running' | 'error'
  toolCount: number
  tools: string[]
  composioToolkit?: string
}

interface SearchResult {
  id: string
  name: string
  description: string
  source: 'managed' | 'catalog' | 'npm'
  installed: boolean
  authType: 'oauth' | 'api_key' | 'none'
  requiredEnv?: Record<string, string>
  composioToolkit?: string
  icon?: string
}

interface ComposioConnectionInfo {
  connectionId: string
  status: string
  statusReason?: string | null
  accountIdentifier?: string | null
}

interface ToolsPanelProps {
  projectId: string
  agentUrl: string | null
  visible: boolean
}

export function ToolsPanel({ projectId, agentUrl, visible }: ToolsPanelProps) {
  const http = useDomainHttp()
  const [installedTools, setInstalledTools] = useState<InstalledTool[]>([])
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [uninstalling, setUninstalling] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [envInputs, setEnvInputs] = useState<Record<string, Record<string, string>>>({})
  const [showEnvForm, setShowEnvForm] = useState<string | null>(null)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
  const [reconnectingToolkit, setReconnectingToolkit] = useState<string | null>(null)
  const [composioConnections, setComposioConnections] = useState<Record<string, ComposioConnectionInfo>>({})

  const loadInstalledTools = useCallback(async () => {
    if (!agentUrl) return
    setIsLoading(true)
    setError(null)
    try {
      const res = await agentFetch(`${agentUrl}/agent/tools/status`)
      if (res.ok) {
        const data = await res.json()
        setInstalledTools(data.tools || [])
      }
      try {
        const connections = await api.getIntegrationConnections(http, projectId)
        const connMap: Record<string, ComposioConnectionInfo> = {}
        for (const conn of connections) {
          const key = conn.toolkit?.toLowerCase() ?? ''
          if (key) {
            connMap[key] = {
              connectionId: conn.id,
              status: conn.status?.toLowerCase() ?? 'unknown',
              statusReason: conn.statusReason,
              accountIdentifier: conn.accountIdentifier,
            }
          }
        }
        setComposioConnections(connMap)
      } catch {
        // non-critical
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }, [agentUrl, http, projectId])

  useEffect(() => {
    if (visible) loadInstalledTools()
  }, [visible, loadInstalledTools])

  const handleSearch = useCallback(async () => {
    if (!agentUrl || !searchQuery.trim()) return
    setIsSearching(true)
    setError(null)
    try {
      const res = await agentFetch(`${agentUrl}/agent/tools/search?q=${encodeURIComponent(searchQuery.trim())}`)
      if (!res.ok) throw new Error('Search failed')
      const data = await res.json()
      setSearchResults(data.results || [])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsSearching(false)
    }
  }, [agentUrl, searchQuery])

  const handleInstall = useCallback(
    async (result: SearchResult) => {
      if (!agentUrl) return

      if (result.authType === 'api_key' && result.requiredEnv && Object.keys(result.requiredEnv).length > 0) {
        const currentEnvs = envInputs[result.id] || {}
        const allFilled = Object.keys(result.requiredEnv).every((k) => currentEnvs[k]?.trim())
        if (!allFilled) {
          setShowEnvForm(result.id)
          return
        }
      }

      if (result.authType === 'oauth' && result.composioToolkit) {
        handleOAuthConnect(result)
        return
      }

      setInstalling(result.id)
      setError(null)
      try {
        const env = envInputs[result.id] || {}
        const res = await agentFetch(`${agentUrl}/agent/tools/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: result.id,
            env: Object.keys(env).length > 0 ? env : undefined,
          }),
        })
        if (!res.ok) {
          const data = await res.json()
          throw new Error(data.error || 'Failed to install tool')
        }
        setShowEnvForm(null)
        await loadInstalledTools()
        setSearchResults((prev) => prev.map((r) => r.id === result.id ? { ...r, installed: true } : r))
      } catch (err: any) {
        setError(err.message)
      } finally {
        setInstalling(null)
      }
    },
    [agentUrl, envInputs, loadInstalledTools],
  )

  const handleUninstall = useCallback(
    async (toolId: string) => {
      if (!agentUrl) return
      setUninstalling(toolId)
      setError(null)
      try {
        const res = await agentFetch(`${agentUrl}/agent/tools/${encodeURIComponent(toolId)}`, {
          method: 'DELETE',
        })
        if (!res.ok) {
          const data = await res.json()
          throw new Error(data.error || 'Failed to uninstall tool')
        }
        await loadInstalledTools()
        setSearchResults((prev) => prev.map((r) => r.id === toolId ? { ...r, installed: false } : r))
      } catch (err: any) {
        setError(err.message)
      } finally {
        setUninstalling(null)
      }
    },
    [agentUrl, loadInstalledTools],
  )

  const handleOAuthConnect = useCallback(
    async (result: SearchResult) => {
      if (!result.composioToolkit) return
      setConnecting(result.id)
      setError(null)

      const preWindow = Platform.OS === 'web' ? preCreateAuthWindow() : null
      console.info(LOG_PREFIX, `Starting OAuth for ${result.composioToolkit}`)

      try {
        const isNative = Platform.OS !== 'web'
        let redirect: string | undefined
        if (isNative) {
          redirect = ExpoLinking.createURL('integrations-callback')
        } else if (isMobileWeb()) {
          const returnUrl = new URL(window.location.href)
          returnUrl.searchParams.set('fromOAuth', '1')
          redirect = returnUrl.toString()
        }

        const callbackUrl = redirect
          ? `${API_URL}/api/integrations/callback?redirect=${encodeURIComponent(redirect)}`
          : `${API_URL}/api/integrations/callback`
        const data = await api.connectIntegration(http, result.composioToolkit, projectId, callbackUrl)
        const redirectUrl = data.data?.redirectUrl
        if (redirectUrl) {
          await openAuthFlow(redirectUrl, { preCreatedWindow: preWindow })
          setConnecting(null)
          await loadInstalledTools()
        } else {
          console.warn(LOG_PREFIX, `No redirectUrl for ${result.composioToolkit}`)
        }
      } catch (err: any) {
        console.error(LOG_PREFIX, `OAuth error for ${result.composioToolkit}:`, err)
        setError(err.message)
        setConnecting(null)
      } finally {
        try {
          if (preWindow && !preWindow.closed) {
            const loc = preWindow.location.href
            if (loc === 'about:blank' || loc === '') preWindow.close()
          }
        } catch { /* COOP */ }
      }
    },
    [http, projectId, loadInstalledTools],
  )

  const handleReconnect = useCallback(async (toolkit: string) => {
    setReconnectingToolkit(toolkit)
    setError(null)

    const preWindow = Platform.OS === 'web' ? preCreateAuthWindow() : null
    console.info(LOG_PREFIX, `Reconnecting ${toolkit}`)

    try {
      const isNative = Platform.OS !== 'web'
      let redirect: string | undefined
      if (isNative) {
        redirect = ExpoLinking.createURL('integrations-callback')
      } else if (isMobileWeb()) {
        const returnUrl = new URL(window.location.href)
        returnUrl.searchParams.set('fromOAuth', '1')
        redirect = returnUrl.toString()
      }

      const callbackUrl = redirect
        ? `${API_URL}/api/integrations/callback?redirect=${encodeURIComponent(redirect)}`
        : `${API_URL}/api/integrations/callback`
      const data = await api.connectIntegration(http, toolkit, projectId, callbackUrl)
      const redirectUrl = data.data?.redirectUrl
      if (redirectUrl) {
        await openAuthFlow(redirectUrl, { preCreatedWindow: preWindow })
        await loadInstalledTools()
      }
    } catch (err: any) {
      console.error(LOG_PREFIX, `Reconnect error for ${toolkit}:`, err)
      setError(err.message)
    } finally {
      setReconnectingToolkit(null)
      try {
        if (preWindow && !preWindow.closed) {
          const loc = preWindow.location.href
          if (loc === 'about:blank' || loc === '') preWindow.close()
        }
      } catch { /* COOP */ }
    }
  }, [http, projectId, loadInstalledTools])

  const handleDisconnect = useCallback(async (connectionId: string) => {
    setDisconnecting(connectionId)
    setError(null)
    try {
      await api.disconnectIntegration(http, connectionId)
      await loadInstalledTools()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setDisconnecting(null)
    }
  }, [http, loadInstalledTools])

  const connectionEntries = Object.entries(composioConnections)
  const expiredConnections = connectionEntries.filter(([, info]) =>
    info.status !== 'active' && info.status !== 'initializing',
  )
  const visibleConnections = connectionEntries.filter(([, info]) =>
    info.status !== 'initializing',
  )
  const hasConnections = visibleConnections.length > 0

  if (!visible) return null

  return (
    <View className="absolute inset-0 flex-col">
      <View className="px-4 py-3 border-b border-border flex-row items-center gap-2">
        <Wrench size={16} className="text-muted-foreground" />
        <Text className="text-sm font-medium text-foreground">Integrations</Text>
        <Text className="text-xs text-muted-foreground">
          {installedTools.length} installed
        </Text>
        <Pressable onPress={loadInstalledTools} className="ml-auto p-1 rounded-md active:bg-muted">
          <RefreshCw size={14} className="text-muted-foreground" />
        </Pressable>
      </View>

      {error && (
        <View className="px-4 py-2 bg-destructive/10 flex-row items-center">
          <Text className="text-xs text-destructive flex-1">{error}</Text>
          <Pressable onPress={() => setError(null)} className="p-1">
            <X size={12} className="text-destructive" />
          </Pressable>
        </View>
      )}

      <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
        {isLoading ? (
          <View className="items-center py-8">
            <ActivityIndicator size="small" />
            <Text className="text-sm text-muted-foreground mt-2">Loading tools...</Text>
          </View>
        ) : (
          <View className="gap-4">
            {/* Search & Discover Section */}
            <View className="gap-2">
              <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Search & Discover
              </Text>
              <View className="flex-row items-center gap-2">
                <View className="flex-1 flex-row items-center border border-border rounded-lg bg-background px-3">
                  <Search size={14} className="text-muted-foreground" />
                  <TextInput
                    placeholder='Search tools (e.g. "google calendar", "slack", "postgres")...'
                    placeholderTextColor="#999"
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    onSubmitEditing={handleSearch}
                    className="flex-1 py-2 px-2 text-sm text-foreground"
                    returnKeyType="search"
                  />
                  {searchQuery.length > 0 && (
                    <Pressable onPress={() => { setSearchQuery(''); setSearchResults([]) }} className="p-1">
                      <X size={12} className="text-muted-foreground" />
                    </Pressable>
                  )}
                </View>
                <Pressable
                  onPress={handleSearch}
                  disabled={isSearching || !searchQuery.trim()}
                  className={cn(
                    'px-4 py-2 bg-primary rounded-lg active:bg-primary/80',
                    (isSearching || !searchQuery.trim()) && 'opacity-50',
                  )}
                >
                  {isSearching ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text className="text-sm font-medium text-primary-foreground">Search</Text>
                  )}
                </Pressable>
              </View>

              {searchResults.length > 0 && (
                <View className="gap-2 mt-1">
                  {searchResults.map((result) => {
                    const isInstalling = installing === result.id
                    const isOAuthConnecting = connecting === result.id
                    const showingEnv = showEnvForm === result.id
                    const connInfo = result.composioToolkit
                      ? composioConnections[result.composioToolkit.toLowerCase()]
                      : undefined
                    const isConnected = !!connInfo && connInfo.status === 'active'

                    return (
                      <View
                        key={`${result.id}-${result.source}`}
                        className="border border-border rounded-lg overflow-hidden"
                      >
                        <View className="px-3 py-2.5 flex-row items-start gap-3">
                          <View className="w-8 h-8 rounded-md bg-muted items-center justify-center">
                            <Text className="text-sm">{result.icon || '🔧'}</Text>
                          </View>
                          <View className="flex-1">
                            <View className="flex-row items-center gap-2">
                              <Text className="text-sm font-medium text-foreground">
                                {result.name}
                              </Text>
                              <View className={cn(
                                'px-1.5 py-0.5 rounded-full',
                                result.source === 'managed' ? 'bg-blue-500/10' :
                                result.source === 'catalog' ? 'bg-green-500/10' : 'bg-muted',
                              )}>
                                <Text className={cn(
                                  'text-[10px] font-medium',
                                  result.source === 'managed' ? 'text-blue-600' :
                                  result.source === 'catalog' ? 'text-green-600' : 'text-muted-foreground',
                                )}>
                                  {result.source === 'managed' ? 'managed' : result.source}
                                </Text>
                              </View>
                              {(result.installed || isConnected) && (
                                <View className="px-1.5 py-0.5 rounded-full bg-green-500/10 flex-row items-center gap-1">
                                  <CheckCircle2 size={10} color="#22c55e" />
                                  <Text className="text-[10px] text-green-600 font-medium">
                                    Installed
                                  </Text>
                                </View>
                              )}
                            </View>
                            <Text className="text-xs text-muted-foreground mt-0.5">
                              {result.description}
                            </Text>
                            {result.authType === 'api_key' && result.requiredEnv && (
                              <View className="flex-row items-center gap-1 mt-1">
                                <Key size={10} className="text-muted-foreground" />
                                <Text className="text-[10px] text-muted-foreground">
                                  Requires: {Object.keys(result.requiredEnv).join(', ')}
                                </Text>
                              </View>
                            )}
                          </View>

                          {!result.installed && !isConnected && (
                            <Pressable
                              onPress={() => handleInstall(result)}
                              disabled={isInstalling || isOAuthConnecting}
                              className={cn(
                                'mt-1 px-3 py-1.5 rounded-md flex-row items-center gap-1.5',
                                result.authType === 'oauth'
                                  ? 'bg-primary active:bg-primary/80'
                                  : 'bg-primary active:bg-primary/80',
                                (isInstalling || isOAuthConnecting) && 'opacity-50',
                              )}
                            >
                              {isInstalling || isOAuthConnecting ? (
                                <ActivityIndicator size="small" color="#fff" />
                              ) : (
                                <>
                                  {result.authType === 'oauth' ? (
                                    <Link2 size={12} color="#fff" />
                                  ) : (
                                    <Download size={12} color="#fff" />
                                  )}
                                  <Text className="text-xs font-medium text-primary-foreground">
                                    {result.authType === 'oauth' ? 'Connect' : 'Install'}
                                  </Text>
                                </>
                              )}
                            </Pressable>
                          )}
                        </View>

                        {showingEnv && result.requiredEnv && (
                          <View className="px-3 pb-3 ml-11">
                            <View className="border border-border rounded-md p-3 bg-muted/30 gap-2">
                              <Text className="text-xs font-medium text-foreground">
                                Required credentials
                              </Text>
                              {Object.entries(result.requiredEnv).map(([key, desc]) => (
                                <View key={key}>
                                  <Text className="text-[10px] text-muted-foreground mb-0.5">
                                    {key}
                                  </Text>
                                  <TextInput
                                    secureTextEntry
                                    placeholder={desc}
                                    placeholderTextColor="#666"
                                    value={envInputs[result.id]?.[key] || ''}
                                    onChangeText={(text) =>
                                      setEnvInputs((prev) => ({
                                        ...prev,
                                        [result.id]: { ...prev[result.id], [key]: text },
                                      }))
                                    }
                                    className="px-2 py-1 text-xs border border-border rounded bg-background text-foreground"
                                  />
                                </View>
                              ))}
                              <View className="flex-row gap-2 mt-2">
                                <Pressable
                                  onPress={() => handleInstall(result)}
                                  className="px-3 py-1 bg-primary rounded-md active:bg-primary/80"
                                >
                                  <Text className="text-xs text-primary-foreground">Install</Text>
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

              {searchResults.length === 0 && searchQuery && !isSearching && (
                <Text className="text-xs text-muted-foreground text-center py-4">
                  No results. Try a different search term.
                </Text>
              )}

              {!searchQuery && searchResults.length === 0 && (
                <Text className="text-xs text-muted-foreground text-center py-4">
                  Search for integrations to add new capabilities to your agent.
                </Text>
              )}
            </View>

            {/* Installed Tools Section */}
            {installedTools.length > 0 && (
              <View className="gap-2">
                <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Installed
                </Text>
                {installedTools.map((tool) => {
                  const isUninstalling = uninstalling === tool.id
                  return (
                    <View
                      key={tool.id}
                      className="border border-border rounded-lg px-3 py-2.5 flex-row items-center gap-3"
                    >
                      <View className="w-8 h-8 rounded-md bg-primary/10 items-center justify-center">
                        <Wrench size={14} className="text-primary" />
                      </View>
                      <View className="flex-1">
                        <View className="flex-row items-center gap-2">
                          <Text className="text-sm font-medium text-foreground">{tool.name}</Text>
                          <View className={cn(
                            'px-1.5 py-0.5 rounded-full',
                            tool.source === 'managed' ? 'bg-blue-500/10' : 'bg-muted',
                          )}>
                            <Text className={cn(
                              'text-[10px] font-medium',
                              tool.source === 'managed' ? 'text-blue-600' : 'text-muted-foreground',
                            )}>
                              {tool.source}
                            </Text>
                          </View>
                          <View className={cn(
                            'w-1.5 h-1.5 rounded-full',
                            tool.status === 'running' ? 'bg-green-500' : 'bg-red-500',
                          )} />
                        </View>
                        <Text className="text-xs text-muted-foreground mt-0.5">
                          {tool.toolCount} tool{tool.toolCount !== 1 ? 's' : ''}
                        </Text>
                      </View>
                      <Tooltip
                        trigger={(triggerProps) => (
                          <Pressable
                            {...triggerProps}
                            onPress={() => handleUninstall(tool.id)}
                            disabled={isUninstalling}
                            className={cn(
                              'p-2 rounded-md active:bg-destructive/10',
                              isUninstalling && 'opacity-50',
                            )}
                          >
                            {isUninstalling ? (
                              <ActivityIndicator size="small" />
                            ) : (
                              <Trash2 size={14} className="text-destructive/70" />
                            )}
                          </Pressable>
                        )}
                      >
                        <TooltipContent>
                          <TooltipText>Uninstall integration</TooltipText>
                        </TooltipContent>
                      </Tooltip>
                    </View>
                  )
                })}
              </View>
            )}

            {/* Connections Section */}
            {hasConnections && (
              <View className="gap-2">
                <View className="flex-row items-center gap-2">
                  <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Connections
                  </Text>
                  {expiredConnections.length > 0 && (
                    <View className="px-1.5 py-0.5 rounded-full bg-orange-500/10 flex-row items-center gap-1">
                      <AlertTriangle size={9} color="#f97316" />
                      <Text className="text-[10px] text-orange-600 font-medium">
                        {expiredConnections.length} expired
                      </Text>
                    </View>
                  )}
                </View>
                {visibleConnections.map(([toolkit, info]) => {
                  const isActive = info.status === 'active'
                  const isReconnecting = reconnectingToolkit === toolkit
                  const isDisconnecting = disconnecting === info.connectionId
                  const displayName = toolkit.charAt(0).toUpperCase() + toolkit.slice(1)

                  return (
                    <View
                      key={toolkit}
                      className={cn(
                        'border rounded-lg px-3 py-2.5 flex-row items-center gap-3',
                        isActive ? 'border-border' : 'border-orange-400/50 bg-orange-50/50 dark:bg-orange-900/10',
                      )}
                    >
                      <View className={cn(
                        'w-8 h-8 rounded-md items-center justify-center',
                        isActive ? 'bg-green-500/10' : 'bg-orange-500/10',
                      )}>
                        {isActive ? (
                          <Link2 size={14} className="text-green-600" />
                        ) : (
                          <AlertTriangle size={14} className="text-orange-500" />
                        )}
                      </View>
                      <View className="flex-1">
                        <View className="flex-row items-center gap-2">
                          <Text className="text-sm font-medium text-foreground">
                            {displayName}
                          </Text>
                          <View className={cn(
                            'w-1.5 h-1.5 rounded-full',
                            isActive ? 'bg-green-500' : 'bg-orange-500',
                          )} />
                        </View>
                        {isActive && info.accountIdentifier ? (
                          <Text className="text-xs text-muted-foreground mt-0.5" numberOfLines={1}>
                            {info.accountIdentifier}
                          </Text>
                        ) : !isActive ? (
                          <Text className="text-xs text-orange-600 dark:text-orange-400 mt-0.5" numberOfLines={1}>
                            {info.statusReason || `Status: ${info.status}`}
                          </Text>
                        ) : (
                          <Text className="text-xs text-muted-foreground mt-0.5">Connected</Text>
                        )}
                      </View>
                      <View className="flex-row items-center gap-1">
                        <Tooltip
                          trigger={(triggerProps) => (
                            <Pressable
                              {...triggerProps}
                              onPress={() => handleReconnect(toolkit)}
                              disabled={isReconnecting || isDisconnecting}
                              className={cn(
                                'p-2 rounded-md',
                                isActive ? 'active:bg-muted' : 'active:bg-orange-100 dark:active:bg-orange-900/30',
                                (isReconnecting || isDisconnecting) && 'opacity-50',
                              )}
                            >
                              {isReconnecting ? (
                                <Loader2 size={14} className={isActive ? 'text-muted-foreground' : 'text-orange-500'} />
                              ) : (
                                <ExternalLink size={14} className={isActive ? 'text-muted-foreground' : 'text-orange-500'} />
                              )}
                            </Pressable>
                          )}
                        >
                          <TooltipContent>
                            <TooltipText>{isActive ? 'Reconnect' : 'Fix connection'}</TooltipText>
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip
                          trigger={(triggerProps) => (
                            <Pressable
                              {...triggerProps}
                              onPress={() => handleDisconnect(info.connectionId)}
                              disabled={isDisconnecting || isReconnecting}
                              className={cn(
                                'p-2 rounded-md active:bg-destructive/10',
                                (isDisconnecting || isReconnecting) && 'opacity-50',
                              )}
                            >
                              {isDisconnecting ? (
                                <ActivityIndicator size="small" />
                              ) : (
                                <Trash2 size={14} className="text-destructive/70" />
                              )}
                            </Pressable>
                          )}
                        >
                          <TooltipContent>
                            <TooltipText>Disconnect</TooltipText>
                          </TooltipContent>
                        </Tooltip>
                      </View>
                    </View>
                  )
                })}
              </View>
            )}

          </View>
        )}
      </ScrollView>
    </View>
  )
}
