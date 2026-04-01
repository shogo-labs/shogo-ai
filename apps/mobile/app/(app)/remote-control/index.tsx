// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  ScrollView,
  RefreshControl,
  Platform,
} from 'react-native'
import { useRouter } from 'expo-router'
import { cn } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../../contexts/auth'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'
import { API_URL } from '../../../lib/api'
import { usePlatformConfig } from '../../../lib/platform-config'
import {
  Monitor,
  Wifi,
  WifiOff,
  ChevronRight,
  Laptop,
  Server,
  RefreshCw,
  Trash2,
  Key,
  ArrowRight,
  Cloud,
  Settings,
  Radio,
  Loader2,
} from 'lucide-react-native'

interface Instance {
  id: string
  name: string
  hostname: string
  os: string | null
  arch: string | null
  status: 'online' | 'heartbeat' | 'offline'
  lastSeenAt: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never'
  const diff = Date.now() - new Date(dateStr).getTime()
  if (diff < 60_000) return 'Just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function getOsIcon(os: string | null) {
  if (!os) return Server
  const lower = os.toLowerCase()
  if (lower === 'darwin' || lower.includes('mac')) return Laptop
  return Laptop
}

function useAuthHeaders() {
  const { session } = useAuth()
  return Platform.OS !== 'web' && session?.token
    ? { Cookie: `better-auth.session_token=${session.token}` }
    : {}
}

export default function RemoteControlScreen() {
  const router = useRouter()
  const { session } = useAuth()
  const workspace = useActiveWorkspace()
  const { localMode, shogoKeyConnected } = usePlatformConfig()
  const [instances, setInstances] = useState<Instance[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const viewerPingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const authHeaders = useAuthHeaders()

  const fetchInstances = useCallback(async () => {
    if (!workspace?.id) {
      setLoading(false)
      return
    }
    try {
      const res = await fetch(`${API_URL}/api/instances?workspaceId=${workspace.id}`, {
        credentials: 'include',
        headers: authHeaders,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setInstances(data.instances || [])
      setError(null)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [workspace?.id, session?.token])

  const signalViewerActive = useCallback(async () => {
    if (!workspace?.id) return
    try {
      await fetch(`${API_URL}/api/instances/viewer-active`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ workspaceId: workspace.id }),
      })
    } catch {}
  }, [workspace?.id, session?.token])

  useEffect(() => {
    fetchInstances()
    signalViewerActive()

    const fetchInterval = setInterval(fetchInstances, 10_000)
    viewerPingRef.current = setInterval(signalViewerActive, 60_000)

    return () => {
      clearInterval(fetchInterval)
      if (viewerPingRef.current) clearInterval(viewerPingRef.current)
    }
  }, [fetchInstances, signalViewerActive])

  const onRefresh = useCallback(() => {
    setRefreshing(true)
    fetchInstances()
  }, [fetchInstances])

  const handleRequestConnect = useCallback(async (instanceId: string) => {
    setConnectingId(instanceId)
    try {
      await fetch(`${API_URL}/api/instances/${instanceId}/request-connect`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
      })

      let attempts = 0
      const maxAttempts = 30
      const pollForOnline = async () => {
        while (attempts < maxAttempts) {
          attempts++
          await new Promise((r) => setTimeout(r, 2000))
          try {
            const res = await fetch(`${API_URL}/api/instances/${instanceId}`, {
              credentials: 'include',
              headers: authHeaders,
            })
            if (res.ok) {
              const data = await res.json()
              if (data.status === 'online') {
                setConnectingId(null)
                router.push(`/(app)/remote-control/${instanceId}` as any)
                return
              }
            }
          } catch {}
        }
        setConnectingId(null)
        setError('Timed out waiting for instance to connect')
      }
      pollForOnline()
    } catch (err: any) {
      setConnectingId(null)
      setError(err.message)
    }
  }, [session?.token, router])

  const handleDelete = useCallback(async (instanceId: string, name: string) => {
    const confirmed = Platform.OS === 'web'
      ? window.confirm(`Remove "${name}" from the registry?`)
      : true
    if (!confirmed) return

    try {
      await fetch(`${API_URL}/api/instances/${instanceId}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: authHeaders,
      })
      setInstances((prev) => prev.filter((i) => i.id !== instanceId))
    } catch {}
  }, [session?.token])

  const onlineInstances = instances.filter((i) => i.status === 'online')
  const heartbeatInstances = instances.filter((i) => i.status === 'heartbeat')
  const offlineInstances = instances.filter((i) => i.status === 'offline')

  if (localMode && !shogoKeyConnected) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <View className="max-w-md items-center">
          <View className="w-16 h-16 rounded-2xl bg-primary/10 items-center justify-center mb-6">
            <Cloud size={32} className="text-primary" />
          </View>
          <Text className="text-xl font-bold text-foreground text-center mb-2">
            Enter your Shogo API Key
          </Text>
          <Text className="text-sm text-muted-foreground text-center leading-5 mb-6">
            Remote Control lets you manage this machine from the Shogo Cloud
            dashboard. Connect your Shogo API key in General Settings to enable
            remote access, cloud LLMs, and more.
          </Text>
          <Pressable
            onPress={() => router.push('/(admin)/general' as any)}
            className="flex-row items-center gap-2 px-5 py-3 rounded-xl bg-primary active:opacity-80"
          >
            <Settings size={16} color="#fff" />
            <Text className="text-sm font-semibold text-primary-foreground">
              Go to General Settings
            </Text>
            <ArrowRight size={14} color="#fff" />
          </Pressable>
        </View>
      </View>
    )
  }

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" />
        <Text className="text-muted-foreground mt-3">Loading instances...</Text>
      </View>
    )
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ padding: 24 }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      {/* Header */}
      <View className="flex-row items-center justify-between mb-6">
        <View>
          <Text className="text-2xl font-bold text-foreground">Remote Control</Text>
          <Text className="text-sm text-muted-foreground mt-1">
            Manage your local Shogo instances
          </Text>
        </View>
        <Pressable
          onPress={onRefresh}
          className="p-2 rounded-md active:bg-muted"
        >
          <RefreshCw size={18} className="text-muted-foreground" />
        </Pressable>
      </View>

      {/* Stats */}
      <View className="flex-row gap-3 mb-6">
        <View className="flex-1 p-4 rounded-lg border border-border bg-card">
          <Text className="text-xs text-muted-foreground uppercase tracking-wider">Connected</Text>
          <Text className="text-2xl font-bold text-green-500 mt-1">{onlineInstances.length}</Text>
        </View>
        <View className="flex-1 p-4 rounded-lg border border-border bg-card">
          <Text className="text-xs text-muted-foreground uppercase tracking-wider">Available</Text>
          <Text className="text-2xl font-bold text-blue-500 mt-1">{heartbeatInstances.length}</Text>
        </View>
        <View className="flex-1 p-4 rounded-lg border border-border bg-card">
          <Text className="text-xs text-muted-foreground uppercase tracking-wider">Total</Text>
          <Text className="text-2xl font-bold text-foreground mt-1">{instances.length}</Text>
        </View>
      </View>

      {error && (
        <View className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 mb-4">
          <Text className="text-sm text-destructive">{error}</Text>
        </View>
      )}

      {instances.length === 0 ? (
        <View className="items-center py-16">
          <Monitor size={48} className="text-muted-foreground/40 mb-4" />
          <Text className="text-lg font-medium text-foreground mb-2">No instances registered</Text>
          <Text className="text-sm text-muted-foreground text-center max-w-sm mb-6">
            Create an API key and enter it in your local Shogo instance's settings.
            It will appear here automatically once connected.
          </Text>
          <Pressable
            onPress={() => router.push('/(app)/api-keys' as any)}
            className="flex-row items-center gap-2 px-4 py-2.5 rounded-lg bg-primary active:opacity-80"
          >
            <Key size={16} color="#fff" />
            <Text className="text-sm font-medium text-primary-foreground">Create API Key</Text>
            <ArrowRight size={14} color="#fff" />
          </Pressable>
        </View>
      ) : (
        <View className="gap-2">
          {onlineInstances.map((instance) => (
            <InstanceCard
              key={instance.id}
              instance={instance}
              connecting={connectingId === instance.id}
              onPress={() => router.push(`/(app)/remote-control/${instance.id}` as any)}
              onConnect={() => {}}
              onDelete={() => handleDelete(instance.id, instance.name)}
            />
          ))}
          {heartbeatInstances.map((instance) => (
            <InstanceCard
              key={instance.id}
              instance={instance}
              connecting={connectingId === instance.id}
              onPress={() => handleRequestConnect(instance.id)}
              onConnect={() => handleRequestConnect(instance.id)}
              onDelete={() => handleDelete(instance.id, instance.name)}
            />
          ))}
          {offlineInstances.map((instance) => (
            <InstanceCard
              key={instance.id}
              instance={instance}
              connecting={connectingId === instance.id}
              onPress={() => router.push(`/(app)/remote-control/${instance.id}` as any)}
              onConnect={() => {}}
              onDelete={() => handleDelete(instance.id, instance.name)}
            />
          ))}
        </View>
      )}
    </ScrollView>
  )
}

function InstanceCard({
  instance,
  connecting,
  onPress,
  onConnect,
  onDelete,
}: {
  instance: Instance
  connecting: boolean
  onPress: () => void
  onConnect: () => void
  onDelete: () => void
}) {
  const isOnline = instance.status === 'online'
  const isHeartbeat = instance.status === 'heartbeat'
  const OsIcon = getOsIcon(instance.os)
  const projectCount = (instance.metadata as any)?.activeProjects ?? null

  return (
    <Pressable
      onPress={onPress}
      disabled={connecting}
      className={cn(
        'flex-row items-center p-4 rounded-lg border bg-card',
        isOnline ? 'border-green-500/30' : isHeartbeat ? 'border-blue-500/30' : 'border-border opacity-60',
      )}
      style={Platform.OS === 'web' ? { cursor: connecting ? 'wait' : 'pointer' } as any : undefined}
    >
      <View className={cn(
        'w-10 h-10 rounded-full items-center justify-center mr-3',
        isOnline ? 'bg-green-500/10' : isHeartbeat ? 'bg-blue-500/10' : 'bg-muted',
      )}>
        <OsIcon size={20} className={isOnline ? 'text-green-500' : isHeartbeat ? 'text-blue-500' : 'text-muted-foreground'} />
      </View>

      <View className="flex-1">
        <View className="flex-row items-center gap-2">
          <Text className="text-base font-medium text-foreground">{instance.name}</Text>
          {isOnline ? (
            <Wifi size={14} className="text-green-500" />
          ) : isHeartbeat ? (
            <Radio size={14} className="text-blue-500" />
          ) : (
            <WifiOff size={14} className="text-muted-foreground" />
          )}
        </View>
        <View className="flex-row items-center gap-2 mt-0.5">
          <Text className="text-xs text-muted-foreground">
            {instance.hostname}
          </Text>
          {instance.os && (
            <Text className="text-xs text-muted-foreground">
              · {instance.os}/{instance.arch || '?'}
            </Text>
          )}
          {projectCount !== null && (
            <Text className="text-xs text-muted-foreground">
              · {projectCount} project{projectCount !== 1 ? 's' : ''}
            </Text>
          )}
        </View>
        <Text className="text-xs text-muted-foreground/70 mt-0.5">
          {connecting
            ? 'Connecting...'
            : isOnline
              ? 'Session active'
              : isHeartbeat
                ? `Polling · Last seen ${formatRelativeTime(instance.lastSeenAt)}`
                : `Last seen ${formatRelativeTime(instance.lastSeenAt)}`}
        </Text>
      </View>

      <View className="flex-row items-center gap-1">
        {connecting ? (
          <ActivityIndicator size="small" />
        ) : isHeartbeat ? (
          <Pressable
            onPress={(e) => { e.stopPropagation?.(); onConnect() }}
            className="px-3 py-1.5 rounded-md bg-blue-500 active:bg-blue-600"
          >
            <Text className="text-xs font-medium text-white">Connect</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={(e) => { e.stopPropagation?.(); onDelete() }}
          className="p-2 rounded-md active:bg-destructive/10"
        >
          <Trash2 size={16} className="text-muted-foreground" />
        </Pressable>
        <ChevronRight size={18} className="text-muted-foreground" />
      </View>
    </Pressable>
  )
}
