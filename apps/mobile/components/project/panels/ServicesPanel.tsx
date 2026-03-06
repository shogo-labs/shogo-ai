import { useState, useEffect, useCallback, useRef } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Platform,
  Linking,
} from 'react-native'
import {
  Globe,
  RefreshCw,
  LogOut,
  ExternalLink,
  Loader2,
  X,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL, api } from '../../../lib/api'
import { useDomainHttp } from '../../../contexts/domain'

interface Connection {
  id: string
  toolkit: string
  status: string
  createdAt?: string
  accountIdentifier?: string | null
}

interface ServicesPanelProps {
  projectId: string
  agentUrl: string | null
  visible: boolean
}

const POLL_INTERVAL_MS = 2500
const POLL_TIMEOUT_MS = 90000
const INITIAL_POLL_DELAY_MS = 5000

const TOOLKIT_DISPLAY: Record<string, { label: string; icon: string }> = {
  gmail: { label: 'Gmail', icon: '📧' },
  googlecalendar: { label: 'Google Calendar', icon: '📅' },
  googledrive: { label: 'Google Drive', icon: '📁' },
  slack: { label: 'Slack', icon: '💼' },
  github: { label: 'GitHub', icon: '🐙' },
  linear: { label: 'Linear', icon: '📐' },
  notion: { label: 'Notion', icon: '📝' },
}

function getToolkitDisplay(toolkit: string) {
  const key = toolkit.toLowerCase().replace(/[-_\s]/g, '')
  return TOOLKIT_DISPLAY[key] ?? { label: toolkit.charAt(0).toUpperCase() + toolkit.slice(1), icon: '🔗' }
}

export function ServicesPanel({ projectId, agentUrl, visible }: ServicesPanelProps) {
  const http = useDomainHttp()
  const [connections, setConnections] = useState<Connection[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState<string | null>(null)
  const pollCancelRef = useRef(false)

  const loadConnections = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const data = await api.getIntegrationConnections(http, projectId)
      setConnections(data as Connection[])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }, [http, projectId])

  useEffect(() => {
    if (visible) loadConnections()
  }, [visible, loadConnections])

  const handleDisconnect = useCallback(async (connectionId: string) => {
    setDisconnecting(connectionId)
    setError(null)
    try {
      await api.disconnectIntegration(http, connectionId)
      await loadConnections()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setDisconnecting(null)
    }
  }, [http, loadConnections])

  const handleReconnect = useCallback(async (toolkit: string) => {
    setReconnecting(toolkit)
    setError(null)
    try {
      const callbackUrl = `${API_URL}/api/integrations/callback`
      const result = await api.connectIntegration(http, toolkit, projectId, callbackUrl)
      const redirectUrl = result.data?.redirectUrl
      if (!redirectUrl) {
        setError('No redirect URL received')
        setReconnecting(null)
        return
      }

      if (Platform.OS === 'web') {
        const width = 600
        const height = 700
        const left = Math.round(window.screenX + (window.outerWidth - width) / 2)
        const top = Math.round(window.screenY + (window.outerHeight - height) / 2)
        window.open(
          redirectUrl,
          'composio-connect',
          `width=${width},height=${height},left=${left},top=${top},popup=true`,
        )

        pollCancelRef.current = false
        const startTime = Date.now()
        await new Promise((r) => setTimeout(r, INITIAL_POLL_DELAY_MS))
        while (!pollCancelRef.current && Date.now() - startTime < POLL_TIMEOUT_MS) {
          try {
            const status = await api.getIntegrationStatus(http, toolkit, projectId)
            if ((status as any)?.data?.connected) {
              await loadConnections()
              setReconnecting(null)
              return
            }
          } catch { /* keep polling */ }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
        }
        setReconnecting(null)
        await loadConnections()
      } else {
        await Linking.openURL(redirectUrl)
        setTimeout(() => {
          setReconnecting(null)
          loadConnections()
        }, 5000)
      }
    } catch (err: any) {
      setError(err.message)
      setReconnecting(null)
    }
  }, [http, projectId, loadConnections])

  useEffect(() => {
    return () => { pollCancelRef.current = true }
  }, [])

  if (!visible) return null

  const activeConnections = connections.filter(
    (c) => c.status?.toLowerCase() === 'active',
  )

  return (
    <View className="absolute inset-0 flex-col">
      <View className="px-4 py-3 border-b border-border flex-row items-center gap-2">
        <Globe size={16} className="text-muted-foreground" />
        <Text className="text-sm font-medium text-foreground">Services</Text>
        <Text className="text-xs text-muted-foreground">
          {activeConnections.length} connected
        </Text>
        <Pressable onPress={loadConnections} className="ml-auto p-1 rounded-md active:bg-muted">
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
            <Text className="text-sm text-muted-foreground mt-2">Loading services...</Text>
          </View>
        ) : activeConnections.length === 0 ? (
          <View className="items-center py-12">
            <Globe size={32} className="text-muted-foreground mb-3" />
            <Text className="text-sm text-muted-foreground mb-1">No connected services</Text>
            <Text className="text-xs text-muted-foreground text-center px-4">
              Connect services like Gmail, Slack, or GitHub from the Tools tab to see them here.
            </Text>
          </View>
        ) : (
          <View className="gap-2">
            {activeConnections.map((conn) => {
              const display = getToolkitDisplay(conn.toolkit)
              const isDisconnecting = disconnecting === conn.id
              const isReconnecting = reconnecting === conn.toolkit

              return (
                <View
                  key={conn.id}
                  className="border border-border rounded-lg px-3 py-3"
                >
                  <View className="flex-row items-center gap-3">
                    <View className="w-9 h-9 rounded-md bg-primary/10 items-center justify-center">
                      <Text className="text-base">{display.icon}</Text>
                    </View>

                    <View className="flex-1">
                      <View className="flex-row items-center gap-2">
                        <Text className="text-sm font-medium text-foreground">
                          {display.label}
                        </Text>
                        <View className="w-1.5 h-1.5 rounded-full bg-green-500" />
                      </View>
                      {conn.accountIdentifier ? (
                        <Text className="text-xs text-muted-foreground mt-0.5" numberOfLines={1}>
                          {conn.accountIdentifier}
                        </Text>
                      ) : (
                        <Text className="text-xs text-muted-foreground mt-0.5">
                          Connected
                        </Text>
                      )}
                    </View>

                    <View className="flex-row items-center gap-1">
                      <Pressable
                        onPress={() => handleReconnect(conn.toolkit)}
                        disabled={isReconnecting || isDisconnecting}
                        className={cn(
                          'p-2 rounded-md active:bg-muted',
                          (isReconnecting || isDisconnecting) && 'opacity-50',
                        )}
                      >
                        {isReconnecting ? (
                          <Loader2 size={14} className="text-muted-foreground" />
                        ) : (
                          <ExternalLink size={14} className="text-muted-foreground" />
                        )}
                      </Pressable>
                      <Pressable
                        onPress={() => handleDisconnect(conn.id)}
                        disabled={isDisconnecting || isReconnecting}
                        className={cn(
                          'p-2 rounded-md active:bg-destructive/10',
                          (isDisconnecting || isReconnecting) && 'opacity-50',
                        )}
                      >
                        {isDisconnecting ? (
                          <ActivityIndicator size="small" />
                        ) : (
                          <LogOut size={14} className="text-muted-foreground" />
                        )}
                      </Pressable>
                    </View>
                  </View>
                </View>
              )
            })}
          </View>
        )}
      </ScrollView>
    </View>
  )
}
