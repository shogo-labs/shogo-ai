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
  Link2,
  Smartphone,
  Zap,
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

function useAuthHeaders(): Record<string, string> {
  const { session } = useAuth()
  if (Platform.OS !== 'web' && session?.token) {
    return { Cookie: `better-auth.session_token=${session.token}` }
  }
  return {}
}

export default function RemoteControlScreen() {
  const router = useRouter()
  const { session } = useAuth()
  const workspace = useActiveWorkspace()
  const { localMode, shogoKeyConnected } = usePlatformConfig()
  const [instances, setInstances] = useState<Instance[]>([])
  const [recentActivity, setRecentActivity] = useState<Array<{
    id: string
    action: string
    instanceId: string
    instanceName?: string
    result?: string
    createdAt: string
  }>>([])
  const [agentStatuses, setAgentStatuses] = useState<Record<string, {
    status?: string
    model?: string
    currentTask?: string
    lastTool?: string
  }>>({})
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
      const list = data.instances || []
      setInstances(list)
      setError(null)
      fetchAggregateActivity(list)
      fetchAgentStatuses(list)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [workspace?.id, session?.token])

  const fetchAggregateActivity = useCallback(async (instanceList: Instance[]) => {
    const onlineIds = instanceList.filter(i => i.status === 'online').map(i => i.id)
    if (onlineIds.length === 0) { setRecentActivity([]); return }

    try {
      const results = await Promise.all(
        onlineIds.slice(0, 5).map(async (id) => {
          const res = await fetch(`${API_URL}/api/instances/${id}/audit?limit=5`, {
            credentials: 'include',
            headers: authHeaders,
          })
          if (!res.ok) return []
          const data = await res.json()
          const inst = instanceList.find(i => i.id === id)
          return (data.actions || []).map((a: any) => ({
            ...a,
            instanceId: id,
            instanceName: inst?.name || id.slice(0, 8),
          }))
        })
      )
      const merged = results.flat().sort((a: any, b: any) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
      setRecentActivity(merged.slice(0, 15))
    } catch {}
  }, [authHeaders])

  const fetchAgentStatuses = useCallback(async (instanceList: Instance[]) => {
    const onlineIds = instanceList.filter(i => i.status === 'online').map(i => i.id)
    if (onlineIds.length === 0) { setAgentStatuses({}); return }

    const entries = await Promise.all(
      onlineIds.slice(0, 10).map(async (id) => {
        try {
          const res = await fetch(`${API_URL}/api/instances/${id}/proxy`, {
            method: 'POST',
            credentials: 'include',
            headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: 'GET', path: '/agent/status' }),
          })
          if (!res.ok) return [id, null] as const
          const data = await res.json()
          const body = data.body ? JSON.parse(data.body) : data
          return [id, {
            status: body.status,
            model: body.model,
            currentTask: body.currentTask,
            lastTool: body.lastTool,
          }] as const
        } catch {
          return [id, null] as const
        }
      })
    )
    const map: Record<string, any> = {}
    for (const [id, status] of entries) {
      if (status) map[id] = status
    }
    setAgentStatuses(map)
  }, [authHeaders])

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
        <View className="flex-row items-center gap-2">
          <Pressable
            onPress={() => router.push('/(app)/remote-control/pair' as any)}
            className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 active:bg-primary/20"
          >
            <Link2 size={14} className="text-primary" />
            <Text className="text-xs font-medium text-primary">Pair</Text>
          </Pressable>
          <Pressable
            onPress={onRefresh}
            className="p-2 rounded-md active:bg-muted"
          >
            <RefreshCw size={18} className="text-muted-foreground" />
          </Pressable>
        </View>
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

      {/* Cross-instance quick actions */}
      {onlineInstances.length > 0 && (
        <View className="flex-row gap-2 mb-4">
          <Pressable
            onPress={async () => {
              for (const inst of onlineInstances) {
                try {
                  await fetch(`${API_URL}/api/instances/${inst.id}/proxy`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body: JSON.stringify({ method: 'POST', path: '/agent/stop' }),
                  })
                } catch {}
              }
            }}
            className="flex-row items-center gap-1.5 px-3 py-2 rounded-lg bg-destructive/10 active:bg-destructive/20"
          >
            <Zap size={14} className="text-destructive" />
            <Text className="text-xs font-medium text-destructive">Stop All Agents</Text>
          </Pressable>
        </View>
      )}

      {error && (
        <View className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 mb-4 flex-row items-center gap-3">
          <View className="flex-1">
            <Text className="text-sm text-destructive">{error}</Text>
          </View>
          <Pressable
            onPress={() => { setError(null); onRefresh() }}
            className="px-3 py-1.5 rounded-md bg-destructive/10 active:bg-destructive/20"
          >
            <Text className="text-xs font-medium text-destructive">Retry</Text>
          </Pressable>
        </View>
      )}

      {instances.length === 0 ? (
        <View className="items-center py-8">
          <View className="w-20 h-20 rounded-2xl bg-primary/10 items-center justify-center mb-6">
            <Smartphone size={36} className="text-primary" />
          </View>
          <Text className="text-xl font-bold text-foreground mb-2">Set Up Remote Control</Text>
          <Text className="text-sm text-muted-foreground text-center max-w-sm mb-8 leading-5">
            Control your desktop Shogo from your phone — manage agents, switch models,
            browse files, and chat remotely.
          </Text>

          <View className="w-full gap-3 mb-6">
            <View className="flex-row items-center gap-3 p-4 rounded-lg border border-border bg-card">
              <View className="w-8 h-8 rounded-full bg-primary/10 items-center justify-center">
                <Text className="text-sm font-bold text-primary">1</Text>
              </View>
              <Text className="flex-1 text-sm text-foreground">Open Shogo on your desktop</Text>
            </View>
            <View className="flex-row items-center gap-3 p-4 rounded-lg border border-border bg-card">
              <View className="w-8 h-8 rounded-full bg-primary/10 items-center justify-center">
                <Text className="text-sm font-bold text-primary">2</Text>
              </View>
              <Text className="flex-1 text-sm text-foreground">Go to Settings → Remote Control</Text>
            </View>
            <View className="flex-row items-center gap-3 p-4 rounded-lg border border-border bg-card">
              <View className="w-8 h-8 rounded-full bg-primary/10 items-center justify-center">
                <Text className="text-sm font-bold text-primary">3</Text>
              </View>
              <Text className="flex-1 text-sm text-foreground">Enter the pairing code or API key</Text>
            </View>
          </View>

          <View className="w-full gap-3">
            <Pressable
              onPress={() => router.push('/(app)/remote-control/pair' as any)}
              className="flex-row items-center justify-center gap-2 py-3 rounded-lg bg-primary active:opacity-80"
            >
              <Link2 size={16} color="#fff" />
              <Text className="text-sm font-medium text-primary-foreground">Pair with Code</Text>
            </Pressable>
            <Pressable
              onPress={() => router.push('/(app)/api-keys' as any)}
              className="flex-row items-center justify-center gap-2 py-3 rounded-lg border border-border active:bg-muted"
            >
              <Key size={16} className="text-foreground" />
              <Text className="text-sm font-medium text-foreground">Use API Key Instead</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View className="gap-2">
          {onlineInstances.map((instance) => (
            <InstanceCard
              key={instance.id}
              instance={instance}
              connecting={connectingId === instance.id}
              agentStatus={agentStatuses[instance.id]}
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

          {/* Aggregate Activity Feed */}
          {recentActivity.length > 0 && (
            <View className="mt-6">
              <Text className="text-sm font-medium text-foreground mb-3">Recent Activity</Text>
              <View className="rounded-lg border border-border bg-card overflow-hidden">
                {recentActivity.slice(0, 10).map((action, i) => (
                  <Pressable
                    key={action.id}
                    onPress={() => router.push(`/(app)/remote-control/${action.instanceId}` as any)}
                    className={cn(
                      'flex-row items-center px-3 py-2.5 active:bg-muted',
                      i > 0 && 'border-t border-border/50',
                    )}
                  >
                    <View className="flex-1">
                      <View className="flex-row items-center gap-1.5">
                        <Text className="text-xs font-medium text-foreground">{action.action}</Text>
                        <Text className="text-[10px] text-muted-foreground">on {action.instanceName}</Text>
                      </View>
                      {action.result && (
                        <Text className="text-[10px] text-muted-foreground mt-0.5">{action.result}</Text>
                      )}
                    </View>
                    <Text className="text-[10px] text-muted-foreground">
                      {formatRelativeTime(action.createdAt)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
        </View>
      )}
    </ScrollView>
  )
}

function InstanceCard({
  instance,
  connecting,
  agentStatus,
  onPress,
  onConnect,
  onDelete,
}: {
  instance: Instance
  connecting: boolean
  agentStatus?: { status?: string; model?: string; currentTask?: string; lastTool?: string } | null
  onPress: () => void
  onConnect: () => void
  onDelete: () => void
}) {
  const isOnline = instance.status === 'online'
  const isHeartbeat = instance.status === 'heartbeat'
  const OsIcon = getOsIcon(instance.os)
  const meta = instance.metadata as any
  const projectCount = meta?.activeProjects ?? null
  const uptime = meta?.uptime ? formatUptime(meta.uptime) : null
  const protocolVersion = meta?.protocolVersion ?? null
  const apiVersion = meta?.apiVersion ?? null

  return (
    <Pressable
      onPress={onPress}
      disabled={connecting}
      className={cn(
        'p-4 rounded-lg border bg-card',
        isOnline ? 'border-green-500/30' : isHeartbeat ? 'border-blue-500/30' : 'border-border opacity-60',
      )}
      style={Platform.OS === 'web' ? { cursor: connecting ? 'wait' : 'pointer' } as any : undefined}
    >
      <View className="flex-row items-center">
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
          </View>
          <Text className="text-xs text-muted-foreground/70 mt-0.5">
            {connecting
              ? 'Connecting...'
              : isOnline
                ? agentStatus?.currentTask
                  ? `Working: ${agentStatus.currentTask}`
                  : agentStatus?.status === 'running' || agentStatus?.status === 'active'
                    ? `Running${agentStatus.model ? ` · ${agentStatus.model}` : ''}`
                    : agentStatus?.status === 'idle'
                      ? `Idle${agentStatus.model ? ` · ${agentStatus.model}` : ''}`
                      : 'Online'
                : isHeartbeat
                  ? `Polling · Last seen ${formatRelativeTime(instance.lastSeenAt)}`
                  : `Last seen ${formatRelativeTime(instance.lastSeenAt)}`}
          </Text>
          {isOnline && agentStatus?.lastTool && (
            <Text className="text-[10px] text-muted-foreground/50 font-mono mt-0.5" numberOfLines={1}>
              last tool: {agentStatus.lastTool}
            </Text>
          )}
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
      </View>

      {/* Per-instance metrics row */}
      {isOnline && (
        <View className="flex-row gap-4 mt-2.5 pt-2.5 border-t border-border/50">
          {projectCount !== null && (
            <View className="flex-row items-center gap-1">
              <View className="w-1.5 h-1.5 rounded-full bg-primary" />
              <Text className="text-[10px] text-muted-foreground">
                {projectCount} project{projectCount !== 1 ? 's' : ''}
              </Text>
            </View>
          )}
          {uptime && (
            <View className="flex-row items-center gap-1">
              <View className="w-1.5 h-1.5 rounded-full bg-green-500" />
              <Text className="text-[10px] text-muted-foreground">Up {uptime}</Text>
            </View>
          )}
          {protocolVersion && (
            <Text className="text-[10px] text-muted-foreground">Proto v{protocolVersion}</Text>
          )}
          {apiVersion && (
            <Text className="text-[10px] text-muted-foreground">API {apiVersion}</Text>
          )}
        </View>
      )}
    </Pressable>
  )
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`
}
