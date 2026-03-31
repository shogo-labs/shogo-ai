// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback } from 'react'
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
} from 'lucide-react-native'

interface Instance {
  id: string
  name: string
  hostname: string
  os: string | null
  arch: string | null
  status: 'online' | 'offline'
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

export default function RemoteControlScreen() {
  const router = useRouter()
  const { session } = useAuth()
  const workspace = useActiveWorkspace()
  const [instances, setInstances] = useState<Instance[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchInstances = useCallback(async () => {
    if (!workspace?.id) return
    try {
      const res = await fetch(`${API_URL}/api/instances?workspaceId=${workspace.id}`, {
        credentials: 'include',
        headers: {
          ...(Platform.OS !== 'web' && session?.token
            ? { Cookie: `better-auth.session_token=${session.token}` }
            : {}),
        },
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

  useEffect(() => {
    fetchInstances()
    const interval = setInterval(fetchInstances, 10_000)
    return () => clearInterval(interval)
  }, [fetchInstances])

  const onRefresh = useCallback(() => {
    setRefreshing(true)
    fetchInstances()
  }, [fetchInstances])

  const handleDelete = useCallback(async (instanceId: string, name: string) => {
    const confirmed = Platform.OS === 'web'
      ? window.confirm(`Remove "${name}" from the registry?`)
      : true
    if (!confirmed) return

    try {
      await fetch(`${API_URL}/api/instances/${instanceId}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: {
          ...(Platform.OS !== 'web' && session?.token
            ? { Cookie: `better-auth.session_token=${session.token}` }
            : {}),
        },
      })
      setInstances((prev) => prev.filter((i) => i.id !== instanceId))
    } catch {}
  }, [session?.token])

  const onlineInstances = instances.filter((i) => i.status === 'online')
  const offlineInstances = instances.filter((i) => i.status === 'offline')

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
          <Text className="text-xs text-muted-foreground uppercase tracking-wider">Online</Text>
          <Text className="text-2xl font-bold text-green-500 mt-1">{onlineInstances.length}</Text>
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
          {/* Online instances first */}
          {onlineInstances.map((instance) => (
            <InstanceCard
              key={instance.id}
              instance={instance}
              onPress={() => router.push(`/(app)/remote-control/${instance.id}` as any)}
              onDelete={() => handleDelete(instance.id, instance.name)}
            />
          ))}
          {/* Offline instances */}
          {offlineInstances.map((instance) => (
            <InstanceCard
              key={instance.id}
              instance={instance}
              onPress={() => router.push(`/(app)/remote-control/${instance.id}` as any)}
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
  onPress,
  onDelete,
}: {
  instance: Instance
  onPress: () => void
  onDelete: () => void
}) {
  const isOnline = instance.status === 'online'
  const OsIcon = getOsIcon(instance.os)
  const projectCount = (instance.metadata as any)?.activeProjects ?? null

  return (
    <Pressable
      onPress={onPress}
      className={cn(
        'flex-row items-center p-4 rounded-lg border bg-card',
        isOnline ? 'border-green-500/30' : 'border-border opacity-60',
      )}
      style={Platform.OS === 'web' ? { cursor: 'pointer' } as any : undefined}
    >
      <View className={cn(
        'w-10 h-10 rounded-full items-center justify-center mr-3',
        isOnline ? 'bg-green-500/10' : 'bg-muted',
      )}>
        <OsIcon size={20} className={isOnline ? 'text-green-500' : 'text-muted-foreground'} />
      </View>

      <View className="flex-1">
        <View className="flex-row items-center gap-2">
          <Text className="text-base font-medium text-foreground">{instance.name}</Text>
          {isOnline ? (
            <Wifi size={14} className="text-green-500" />
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
          {isOnline ? 'Connected' : `Last seen ${formatRelativeTime(instance.lastSeenAt)}`}
        </Text>
      </View>

      <View className="flex-row items-center gap-1">
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
