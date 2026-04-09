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
  TextInput,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { cn } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../../contexts/auth'
import { API_URL } from '../../../lib/api'
import {
  getProtocolVersion,
  isCapabilityAvailable,
  classifyLatency,
  type ConnectionQuality,
  type ConnectionMode,
} from '../../../lib/remote-control/capabilities'
import { resolveConnectionMode } from '../../../lib/remote-control/lan-discovery'
import {
  ArrowLeft,
  Wifi,
  WifiOff,
  Laptop,
  Server,
  Play,
  Square,
  RefreshCw,
  FolderTree,
  MessageSquare,
  Activity,
  Settings,
  Send,
  ChevronRight,
  Pencil,
  Check,
  X,
  AlertTriangle,
  Zap,
  RotateCw,
  ClipboardList,
  Globe,
  Radio,
  Terminal,
  Pause,
} from 'lucide-react-native'

interface InstanceDetail {
  id: string
  name: string
  hostname: string
  os: string | null
  arch: string | null
  status: 'online' | 'offline'
  lastSeenAt: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
  controllers?: Array<{ userId: string; lastSeenAt: number }>
}

interface ProxyResponse {
  status: number
  headers?: Record<string, string>
  body?: string
  error?: { code: string; message: string }
}

type Tab = 'status' | 'chat' | 'logs' | 'files' | 'controls' | 'audit'

const QUALITY_COLORS: Record<ConnectionQuality, string> = {
  good: 'text-green-500',
  fair: 'text-yellow-500',
  poor: 'text-red-500',
  unknown: 'text-muted-foreground',
}

export default function InstanceDetailScreen() {
  const { instanceId } = useLocalSearchParams<{ instanceId: string }>()
  const router = useRouter()
  const { session } = useAuth()
  const [instance, setInstance] = useState<InstanceDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<Tab>('status')
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality>('unknown')
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [isReconnecting, setIsReconnecting] = useState(false)
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('cloud')
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const headers = useCallback(() => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (Platform.OS !== 'web' && session?.token) {
      h.Cookie = `better-auth.session_token=${session.token}`
    }
    return h
  }, [session?.token])

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToastMessage(null), 4000)
  }, [])

  const fetchInstance = useCallback(async () => {
    if (!instanceId) return
    try {
      const res = await fetch(`${API_URL}/api/instances/${instanceId}`, {
        credentials: 'include',
        headers: headers(),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setInstance(data)
    } catch {}
    setLoading(false)
  }, [instanceId, headers])

  useEffect(() => {
    fetchInstance()
    const interval = setInterval(fetchInstance, 10_000)
    return () => clearInterval(interval)
  }, [fetchInstance])

  // Latency ping
  const measureLatency = useCallback(async () => {
    if (!instanceId || !instance || instance.status !== 'online') return
    try {
      const start = Date.now()
      const res = await fetch(`${API_URL}/api/instances/${instanceId}/ping`, {
        method: 'POST',
        credentials: 'include',
        headers: headers(),
      })
      if (res.ok) {
        const data = await res.json()
        const rtt = data.rttMs ?? (Date.now() - start)
        setLatencyMs(rtt)
        setConnectionQuality(classifyLatency(rtt))
      } else {
        setConnectionQuality('poor')
      }
    } catch {
      setConnectionQuality('poor')
    }
  }, [instanceId, instance?.status, headers])

  useEffect(() => {
    measureLatency()
    if (instanceId) {
      resolveConnectionMode(instanceId).then(({ mode }) => setConnectionMode(mode))
    }
    pingRef.current = setInterval(measureLatency, 10_000)
    return () => { if (pingRef.current) clearInterval(pingRef.current) }
  }, [measureLatency, instanceId])

  const proxyRequest = useCallback(async (
    method: string,
    path: string,
    body?: string,
  ): Promise<ProxyResponse | null> => {
    if (!instanceId) return null
    try {
      const res = await fetch(`${API_URL}/api/instances/${instanceId}/proxy`, {
        method: 'POST',
        credentials: 'include',
        headers: headers(),
        body: JSON.stringify({ method, path, body }),
      })
      const data = await res.json()
      if (res.status === 503) {
        showToast('Instance is offline — try reconnecting')
        return null
      }
      if (data.error && data.error.code === 'proxy_error') {
        showToast(data.error.message || 'Proxy request failed')
        return null
      }
      if (data.status === 404) {
        showToast('This action requires a newer desktop app')
        return null
      }
      return data
    } catch {
      showToast('Network error — check your connection')
      return null
    }
  }, [instanceId, headers, showToast])

  const handleReconnect = useCallback(async () => {
    if (!instanceId) return
    setIsReconnecting(true)
    try {
      await fetch(`${API_URL}/api/instances/${instanceId}/request-connect`, {
        method: 'POST',
        credentials: 'include',
        headers: headers(),
      })
      showToast('Reconnect requested — waiting for instance...')
      let attempts = 0
      while (attempts < 15) {
        attempts++
        await new Promise((r) => setTimeout(r, 2000))
        const res = await fetch(`${API_URL}/api/instances/${instanceId}`, {
          credentials: 'include',
          headers: headers(),
        })
        if (res.ok) {
          const data = await res.json()
          if (data.status === 'online') {
            setInstance(data)
            showToast('Reconnected!')
            break
          }
        }
      }
    } catch {}
    setIsReconnecting(false)
  }, [instanceId, headers, showToast])

  const handleRename = useCallback(async () => {
    if (!instanceId || !renameValue.trim()) return
    try {
      const res = await fetch(`${API_URL}/api/instances/${instanceId}`, {
        method: 'PUT',
        credentials: 'include',
        headers: headers(),
        body: JSON.stringify({ name: renameValue.trim() }),
      })
      if (res.ok) {
        const updated = await res.json()
        setInstance((prev) => prev ? { ...prev, name: updated.name } : prev)
        showToast('Instance renamed')
      }
    } catch {}
    setIsRenaming(false)
  }, [instanceId, renameValue, headers, showToast])

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  if (!instance) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Text className="text-lg text-muted-foreground">Instance not found</Text>
        <Pressable onPress={() => router.back()} className="mt-4 px-4 py-2 rounded-md bg-primary">
          <Text className="text-primary-foreground">Go Back</Text>
        </Pressable>
      </View>
    )
  }

  const isOnline = instance.status === 'online'
  const protocolVersion = getProtocolVersion(instance.metadata)

  return (
    <View className="flex-1 bg-background">
      {/* Toast */}
      {toastMessage && (
        <View className="absolute top-2 left-4 right-4 z-50 p-3 rounded-lg bg-foreground/90">
          <Text className="text-sm text-background text-center">{toastMessage}</Text>
        </View>
      )}

      {/* Header */}
      <View className="px-4 pt-4 pb-3 border-b border-border">
        <View className="flex-row items-center gap-3">
          <Pressable onPress={() => router.back()} className="p-1 rounded-md active:bg-muted">
            <ArrowLeft size={20} className="text-foreground" />
          </Pressable>
          <View className="flex-1">
            {isRenaming ? (
              <View className="flex-row items-center gap-2">
                <TextInput
                  value={renameValue}
                  onChangeText={setRenameValue}
                  autoFocus
                  className="flex-1 px-2 py-1 rounded border border-border bg-card text-foreground text-base font-bold"
                  onSubmitEditing={handleRename}
                />
                <Pressable onPress={handleRename} className="p-1">
                  <Check size={18} className="text-green-500" />
                </Pressable>
                <Pressable onPress={() => setIsRenaming(false)} className="p-1">
                  <X size={18} className="text-muted-foreground" />
                </Pressable>
              </View>
            ) : (
              <View className="flex-row items-center gap-2">
                <Text className="text-lg font-bold text-foreground">{instance.name}</Text>
                <Pressable
                  onPress={() => { setRenameValue(instance.name); setIsRenaming(true) }}
                  className="p-1 rounded active:bg-muted"
                >
                  <Pencil size={14} className="text-muted-foreground" />
                </Pressable>
                {isOnline ? (
                  <Wifi size={16} className="text-green-500" />
                ) : (
                  <WifiOff size={16} className="text-muted-foreground" />
                )}
              </View>
            )}
            <View className="flex-row items-center gap-2 mt-0.5">
              <Text className="text-xs text-muted-foreground">
                {instance.hostname} · {instance.os || 'unknown'}/{instance.arch || '?'}
              </Text>
              {isOnline && (
                <View className="flex-row items-center gap-1.5">
                  {latencyMs !== null && (
                    <Text className={cn('text-xs font-mono', QUALITY_COLORS[connectionQuality])}>
                      {latencyMs}ms
                    </Text>
                  )}
                  <View className="flex-row items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-muted">
                    {connectionMode === 'lan' ? (
                      <Radio size={10} className="text-green-500" />
                    ) : (
                      <Globe size={10} className="text-blue-500" />
                    )}
                    <Text className="text-[10px] font-medium text-muted-foreground uppercase">
                      {connectionMode}
                    </Text>
                  </View>
                </View>
              )}
            </View>
          </View>
        </View>

        {/* Tabs */}
        <View className="flex-row gap-1 mt-3">
          {([
            { key: 'status' as Tab, label: 'Status', icon: Activity },
            { key: 'chat' as Tab, label: 'Chat', icon: MessageSquare },
            { key: 'logs' as Tab, label: 'Logs', icon: Terminal },
            { key: 'controls' as Tab, label: 'Controls', icon: Settings },
            { key: 'audit' as Tab, label: 'Audit', icon: ClipboardList },
          ]).map(({ key, label, icon: Icon }) => (
            <Pressable
              key={key}
              onPress={() => setActiveTab(key)}
              className={cn(
                'flex-row items-center gap-1.5 px-3 py-1.5 rounded-md',
                activeTab === key ? 'bg-primary/10' : 'active:bg-muted',
              )}
            >
              <Icon size={14} className={activeTab === key ? 'text-primary' : 'text-muted-foreground'} />
              <Text className={cn(
                'text-sm',
                activeTab === key ? 'text-primary font-medium' : 'text-muted-foreground',
              )}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Degradation Banner */}
      {!isOnline && (
        <View className="mx-4 mt-3 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20 flex-row items-center gap-3">
          <AlertTriangle size={18} className="text-yellow-500" />
          <View className="flex-1">
            <Text className="text-sm font-medium text-foreground">Instance Offline</Text>
            <Text className="text-xs text-muted-foreground">
              Controls, chat, and files are unavailable until the instance reconnects.
            </Text>
          </View>
          <Pressable
            onPress={handleReconnect}
            disabled={isReconnecting}
            className="px-3 py-1.5 rounded-md bg-yellow-500/20 active:bg-yellow-500/30"
          >
            {isReconnecting ? (
              <ActivityIndicator size="small" />
            ) : (
              <Text className="text-xs font-medium text-yellow-600">Reconnect</Text>
            )}
          </Pressable>
        </View>
      )}

      {connectionQuality === 'poor' && isOnline && (
        <View className="mx-4 mt-3 p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 flex-row items-center gap-2">
          <Zap size={14} className="text-red-500" />
          <Text className="text-xs text-red-500">
            Poor connection — some features may be slow or unavailable
          </Text>
        </View>
      )}

      {/* Tab Content */}
      {!isOnline ? (
        <View className="flex-1 items-center justify-center p-8">
          <WifiOff size={48} className="text-muted-foreground/40 mb-4" />
          <Text className="text-lg font-medium text-foreground mb-2">Waiting for Connection</Text>
          <Text className="text-sm text-muted-foreground text-center mb-4">
            Start the local Shogo server with a Shogo API key, or tap Reconnect above.
          </Text>
          <Pressable
            onPress={handleReconnect}
            disabled={isReconnecting}
            className="flex-row items-center gap-2 px-4 py-2 rounded-lg bg-primary active:opacity-80"
          >
            <RotateCw size={14} color="#fff" />
            <Text className="text-sm font-medium text-primary-foreground">
              {isReconnecting ? 'Connecting...' : 'Request Connection'}
            </Text>
          </Pressable>
        </View>
      ) : (
        <>
          {activeTab === 'status' && <StatusTab instance={instance} proxyRequest={proxyRequest} protocolVersion={protocolVersion} />}
          {activeTab === 'chat' && <ChatTab instanceId={instanceId!} headers={headers} showToast={showToast} />}
          {activeTab === 'logs' && <LogsTab instanceId={instanceId!} headers={headers} showToast={showToast} />}
          {activeTab === 'controls' && <ControlsTab instanceId={instanceId!} proxyRequest={proxyRequest} protocolVersion={protocolVersion} showToast={showToast} />}
          {activeTab === 'audit' && <AuditTab instanceId={instanceId!} headers={headers} />}
        </>
      )}
    </View>
  )
}

// ─── Status Tab ─────────────────────────────────────────────────────────────

function StatusTab({
  instance,
  proxyRequest,
  protocolVersion,
}: {
  instance: InstanceDetail
  proxyRequest: (method: string, path: string) => Promise<ProxyResponse | null>
  protocolVersion: number
}) {
  const [agentStatus, setAgentStatus] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<string>('')

  const fetchAgentStatus = useCallback(async () => {
    const resp = await proxyRequest('GET', '/agent/status')
    if (resp?.body) {
      try { setAgentStatus(JSON.parse(resp.body)) } catch {}
    }
    setLoading(false)
    setLastRefresh(new Date().toLocaleTimeString())
  }, [proxyRequest])

  useEffect(() => {
    fetchAgentStatus()
    const interval = setInterval(fetchAgentStatus, 5_000)
    return () => clearInterval(interval)
  }, [fetchAgentStatus])

  const meta = instance.metadata as any
  const agent = agentStatus as any

  return (
    <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
      {/* Agent activity — the most important thing */}
      <SectionCard title="Agent Activity">
        {loading ? (
          <ActivityIndicator size="small" />
        ) : agent ? (
          <>
            <View className="flex-row items-center gap-2 mb-2">
              <View className={cn(
                'w-2.5 h-2.5 rounded-full',
                agent.status === 'running' || agent.status === 'active' ? 'bg-green-500' :
                agent.status === 'idle' ? 'bg-yellow-500' : 'bg-muted-foreground',
              )} />
              <Text className="text-base font-medium text-foreground capitalize">
                {agent.status || 'Unknown'}
              </Text>
              <Text className="text-xs text-muted-foreground ml-auto">{lastRefresh}</Text>
            </View>

            {agent.mode && <InfoRow label="Mode" value={String(agent.mode)} />}
            {agent.model && <InfoRow label="Model" value={String(agent.model)} />}
            {agent.currentTask && (
              <View className="mt-2 p-2.5 rounded-md bg-primary/5 border border-primary/10">
                <Text className="text-xs text-muted-foreground mb-0.5">Currently doing</Text>
                <Text className="text-sm text-foreground">{String(agent.currentTask)}</Text>
              </View>
            )}
            {agent.lastTool && (
              <View className="mt-1.5">
                <Text className="text-xs text-muted-foreground">Last tool: <Text className="font-mono text-foreground">{String(agent.lastTool)}</Text></Text>
              </View>
            )}
            {agent.channels && (
              <InfoRow label="Active Channels" value={String(Object.keys(agent.channels).length)} />
            )}
            {agent.tokenUsage && (
              <InfoRow label="Tokens Used" value={String(agent.tokenUsage)} />
            )}
          </>
        ) : (
          <Text className="text-sm text-muted-foreground">Agent not responding — it may be starting up</Text>
        )}
      </SectionCard>

      {/* Projects with live status */}
      {meta?.projects && Array.isArray(meta.projects) && meta.projects.length > 0 && (
        <SectionCard title="Projects">
          {meta.projects.map((p: any, i: number) => (
            <View key={i} className="flex-row items-center gap-2">
              <View className={cn(
                'w-2 h-2 rounded-full',
                p.status === 'running' ? 'bg-green-500' :
                p.status === 'idle' ? 'bg-yellow-500' : 'bg-muted-foreground',
              )} />
              <Text className="text-sm text-foreground flex-1">{p.projectId?.slice(0, 12) || `Project ${i + 1}`}</Text>
              <Text className="text-xs text-muted-foreground capitalize">{p.status || 'unknown'}</Text>
            </View>
          ))}
        </SectionCard>
      )}

      {instance.controllers && instance.controllers.length > 1 && (
        <SectionCard title="Other Controllers">
          {instance.controllers.map((c, i) => (
            <InfoRow key={i} label={c.userId.slice(0, 12) + '...'} value="Connected" />
          ))}
          <Text className="text-xs text-yellow-500 mt-1">
            Multiple controllers — actions use last-write-wins
          </Text>
        </SectionCard>
      )}

      {/* Instance details — less prominent */}
      <SectionCard title="Instance">
        <InfoRow label="Hostname" value={instance.hostname} />
        <InfoRow label="OS" value={`${instance.os || '?'} / ${instance.arch || '?'}`} />
        <InfoRow label="Uptime" value={meta?.uptime ? `${Math.floor(meta.uptime / 60)}m` : '?'} />
        {meta?.apiVersion && <InfoRow label="Version" value={`${meta.apiVersion} (proto v${protocolVersion})`} />}
      </SectionCard>
    </ScrollView>
  )
}

// ─── Chat Tab ───────────────────────────────────────────────────────────────

function ChatTab({
  instanceId,
  headers,
  showToast,
}: {
  instanceId: string
  headers: () => Record<string, string>
  showToast: (msg: string) => void
}) {
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  const sendMessage = useCallback(async () => {
    if (!input.trim() || sending) return
    const userMsg = input.trim()
    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: userMsg }])
    setSending(true)

    try {
      const res = await fetch(`${API_URL}/api/instances/${instanceId}/proxy/stream`, {
        method: 'POST',
        credentials: 'include',
        headers: headers(),
        body: JSON.stringify({
          method: 'POST',
          path: '/agent/chat',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: [{ type: 'text', text: userMsg }] }],
          }),
        }),
      })

      if (res.status === 503) {
        showToast('Instance is offline — message not sent')
        setSending(false)
        return
      }

      const reader = res.body?.getReader()
      if (!reader) return

      const decoder = new TextDecoder()
      let assistantText = ''
      setMessages((prev) => [...prev, { role: 'assistant', content: '' }])

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        assistantText += chunk
        setMessages((prev) => {
          const copy = [...prev]
          copy[copy.length - 1] = { role: 'assistant', content: assistantText }
          return copy
        })
      }
    } catch (err: any) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${err.message}` }])
      showToast('Failed to get response from agent')
    } finally {
      setSending(false)
    }
  }, [input, sending, instanceId, headers, showToast])

  return (
    <View className="flex-1">
      <ScrollView className="flex-1 p-4" contentContainerStyle={{ gap: 12 }}>
        {messages.length === 0 && (
          <View className="items-center py-16">
            <MessageSquare size={32} className="text-muted-foreground/40 mb-3" />
            <Text className="text-sm text-muted-foreground">
              Send a message to the remote agent
            </Text>
          </View>
        )}
        {messages.map((msg, i) => (
          <View
            key={i}
            className={cn(
              'p-3 rounded-lg max-w-[80%]',
              msg.role === 'user'
                ? 'self-end bg-primary/10'
                : 'self-start bg-muted',
            )}
          >
            <Text className="text-sm text-foreground">{msg.content || '...'}</Text>
          </View>
        ))}
        {sending && (
          <View className="self-start">
            <ActivityIndicator size="small" />
          </View>
        )}
      </ScrollView>

      <View className="flex-row items-center gap-2 p-3 border-t border-border">
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Send a message..."
          placeholderTextColor="#999"
          className="flex-1 px-3 py-2 rounded-lg border border-border bg-card text-foreground text-sm"
          onSubmitEditing={sendMessage}
          editable={!sending}
        />
        <Pressable
          onPress={sendMessage}
          disabled={!input.trim() || sending}
          className={cn(
            'p-2.5 rounded-lg',
            input.trim() && !sending ? 'bg-primary' : 'bg-muted',
          )}
        >
          <Send size={16} className={input.trim() && !sending ? 'text-primary-foreground' : 'text-muted-foreground'} />
        </Pressable>
      </View>
    </View>
  )
}

// ─── Logs Tab (live streaming) ──────────────────────────────────────────────

function LogsTab({
  instanceId,
  headers,
  showToast,
}: {
  instanceId: string
  headers: Record<string, string>
  showToast: (msg: string) => void
}) {
  const [lines, setLines] = useState<string[]>([])
  const [streaming, setStreaming] = useState(false)
  const [paused, setPaused] = useState(false)
  const scrollRef = useRef<ScrollView>(null)
  const abortRef = useRef<AbortController | null>(null)
  const pausedRef = useRef(false)

  const MAX_LINES = 500

  const startStream = useCallback(async () => {
    if (streaming) return
    setStreaming(true)
    setPaused(false)
    pausedRef.current = false

    const abort = new AbortController()
    abortRef.current = abort

    try {
      const res = await fetch(`${API_URL}/api/instances/${instanceId}/proxy/stream`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'GET', path: '/agent/logs/stream' }),
        signal: abort.signal,
      })

      if (!res.ok || !res.body) {
        showToast(`Log stream failed: HTTP ${res.status}`)
        setStreaming(false)
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n')
        buffer = parts.pop() || ''

        const newLines = parts.filter((l) => l.trim())
        if (newLines.length > 0 && !pausedRef.current) {
          setLines((prev) => {
            const combined = [...prev, ...newLines]
            return combined.length > MAX_LINES ? combined.slice(-MAX_LINES) : combined
          })
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        showToast('Log stream disconnected')
      }
    } finally {
      setStreaming(false)
    }
  }, [instanceId, headers, streaming, showToast])

  const stopStream = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const togglePause = useCallback(() => {
    setPaused((p) => {
      pausedRef.current = !p
      return !p
    })
  }, [])

  const clearLogs = useCallback(() => {
    setLines([])
  }, [])

  useEffect(() => {
    return () => { abortRef.current?.abort() }
  }, [])

  useEffect(() => {
    if (!paused) {
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 50)
    }
  }, [lines, paused])

  const logLevelColor = (line: string) => {
    if (/\berror\b/i.test(line)) return 'text-red-400'
    if (/\bwarn\b/i.test(line)) return 'text-yellow-400'
    if (/\bdebug\b/i.test(line)) return 'text-blue-400'
    return 'text-green-300'
  }

  return (
    <View className="flex-1">
      <View className="flex-row items-center gap-2 px-4 py-2 border-b border-border">
        {!streaming ? (
          <Pressable
            onPress={startStream}
            className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-md bg-green-600 active:opacity-80"
          >
            <Play size={12} color="#fff" />
            <Text className="text-xs font-medium text-white">Start Streaming</Text>
          </Pressable>
        ) : (
          <>
            <Pressable
              onPress={stopStream}
              className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-600 active:opacity-80"
            >
              <Square size={12} color="#fff" />
              <Text className="text-xs font-medium text-white">Stop</Text>
            </Pressable>
            <Pressable
              onPress={togglePause}
              className={cn(
                'flex-row items-center gap-1.5 px-3 py-1.5 rounded-md active:opacity-80',
                paused ? 'bg-yellow-600' : 'bg-muted',
              )}
            >
              {paused
                ? <Play size={12} color="#fff" />
                : <Pause size={12} className="text-foreground" />
              }
              <Text className={cn('text-xs font-medium', paused ? 'text-white' : 'text-foreground')}>
                {paused ? 'Resume' : 'Pause'}
              </Text>
            </Pressable>
          </>
        )}
        <Pressable onPress={clearLogs} className="ml-auto px-2 py-1.5 rounded-md active:bg-muted">
          <Text className="text-xs text-muted-foreground">Clear</Text>
        </Pressable>
        <Text className="text-xs text-muted-foreground">{lines.length} lines</Text>
      </View>

      <ScrollView
        ref={scrollRef}
        className="flex-1 bg-[#1a1a2e]"
        contentContainerStyle={{ padding: 12 }}
      >
        {lines.length === 0 ? (
          <View className="items-center py-16">
            <Terminal size={28} className="text-muted-foreground/40 mb-3" />
            <Text className="text-sm text-muted-foreground">
              {streaming ? 'Waiting for logs...' : 'Tap "Start Streaming" to see live agent logs'}
            </Text>
          </View>
        ) : (
          lines.map((line, i) => (
            <Text key={i} className={cn('text-xs font-mono leading-5', logLevelColor(line))}>
              {line}
            </Text>
          ))
        )}
      </ScrollView>
    </View>
  )
}

// ─── Files Tab ──────────────────────────────────────────────────────────────

function FilesTab({
  instanceId,
  proxyRequest,
}: {
  instanceId: string
  proxyRequest: (method: string, path: string) => Promise<ProxyResponse | null>
}) {
  const [tree, setTree] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [currentPath, setCurrentPath] = useState('/')
  const [fileContent, setFileContent] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      const resp = await proxyRequest('GET', '/agent/workspace/tree')
      if (resp?.body) {
        try { setTree(JSON.parse(resp.body)) } catch {}
      }
      setLoading(false)
    })()
  }, [proxyRequest])

  const openFile = useCallback(async (filePath: string) => {
    const resp = await proxyRequest('GET', `/agent/workspace/files/${filePath}`)
    if (resp?.body) {
      setFileContent(resp.body)
      setCurrentPath(filePath)
    }
  }, [proxyRequest])

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  if (fileContent !== null) {
    return (
      <View className="flex-1">
        <View className="flex-row items-center gap-2 px-4 py-2 border-b border-border">
          <Pressable onPress={() => setFileContent(null)} className="p-1 rounded active:bg-muted">
            <ArrowLeft size={16} className="text-foreground" />
          </Pressable>
          <Text className="text-sm font-mono text-muted-foreground flex-1" numberOfLines={1}>
            {currentPath}
          </Text>
        </View>
        <ScrollView className="flex-1 p-4">
          <Text className="font-mono text-xs text-foreground">{fileContent}</Text>
        </ScrollView>
      </View>
    )
  }

  return (
    <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
      {tree ? (
        <FileTreeNode node={tree} onOpenFile={openFile} depth={0} />
      ) : (
        <Text className="text-sm text-muted-foreground">Could not load file tree</Text>
      )}
    </ScrollView>
  )
}

function FileTreeNode({
  node,
  onOpenFile,
  depth,
}: {
  node: any
  onOpenFile: (path: string) => void
  depth: number
}) {
  const [expanded, setExpanded] = useState(depth < 1)

  if (!node) return null

  if (node.type === 'file') {
    return (
      <Pressable
        onPress={() => onOpenFile(node.path || node.name)}
        className="flex-row items-center py-1 active:bg-muted rounded"
        style={{ paddingLeft: depth * 16 }}
      >
        <Text className="text-sm text-foreground">{node.name}</Text>
      </Pressable>
    )
  }

  const children = node.children || []
  return (
    <View>
      <Pressable
        onPress={() => setExpanded(!expanded)}
        className="flex-row items-center py-1 active:bg-muted rounded"
        style={{ paddingLeft: depth * 16 }}
      >
        <ChevronRight
          size={14}
          className="text-muted-foreground mr-1"
          style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}
        />
        <Text className="text-sm font-medium text-foreground">{node.name || '/'}</Text>
      </Pressable>
      {expanded && children.map((child: any, i: number) => (
        <FileTreeNode key={child.name || i} node={child} onOpenFile={onOpenFile} depth={depth + 1} />
      ))}
    </View>
  )
}

// ─── Controls Tab ───────────────────────────────────────────────────────────

function ControlsTab({
  instanceId,
  proxyRequest,
  protocolVersion,
  showToast,
}: {
  instanceId: string
  proxyRequest: (method: string, path: string, body?: string) => Promise<ProxyResponse | null>
  protocolVersion: number
  showToast: (msg: string) => void
}) {
  const [result, setResult] = useState<string | null>(null)
  const [currentModel, setCurrentModel] = useState<string | null>(null)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [loadingModel, setLoadingModel] = useState(false)

  const AVAILABLE_MODELS = [
    { id: 'gpt-4o', label: 'GPT-4o', provider: 'OpenAI' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'OpenAI' },
    { id: 'claude-4-sonnet', label: 'Claude 4 Sonnet', provider: 'Anthropic' },
    { id: 'claude-4-opus', label: 'Claude 4 Opus', provider: 'Anthropic' },
    { id: 'claude-3.5-sonnet', label: 'Claude 3.5 Sonnet', provider: 'Anthropic' },
    { id: 'o3', label: 'o3', provider: 'OpenAI' },
    { id: 'o4-mini', label: 'o4-mini', provider: 'OpenAI' },
  ]

  const fetchCurrentModel = useCallback(async () => {
    const resp = await proxyRequest('GET', '/agent/model')
    if (resp?.body) {
      try {
        const data = JSON.parse(resp.body)
        setCurrentModel(data.model || data.modelId || null)
      } catch {}
    }
  }, [proxyRequest])

  useEffect(() => { fetchCurrentModel() }, [fetchCurrentModel])

  const switchModel = useCallback(async (modelId: string) => {
    setLoadingModel(true)
    setShowModelPicker(false)
    const resp = await proxyRequest('POST', '/agent/model', JSON.stringify({ model: modelId }))
    if (resp && resp.status === 200) {
      setCurrentModel(modelId)
      showToast(`Switched to ${modelId}`)
      setResult(`Model switched to ${modelId}`)
    } else {
      showToast('Failed to switch model')
      setResult(`Model switch failed: HTTP ${resp?.status || 'unknown'}`)
    }
    setLoadingModel(false)
  }, [proxyRequest, showToast])

  const executeAction = useCallback(async (label: string, method: string, path: string, body?: string) => {
    setResult(`Executing: ${label}...`)
    const resp = await proxyRequest(method, path, body)
    if (resp) {
      setResult(`${label}: ${resp.status === 200 ? 'Success' : `HTTP ${resp.status}`}`)
    } else {
      setResult(`${label}: Failed`)
    }
  }, [proxyRequest])

  const canSwitchModel = isCapabilityAvailable('modelSwitch', protocolVersion)

  return (
    <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
      {/* Model switching — the most common remote action */}
      {canSwitchModel && (
        <SectionCard title="Model">
          <View className="flex-row items-center justify-between mb-2">
            <View>
              <Text className="text-sm text-muted-foreground">Current model</Text>
              <Text className="text-base font-medium text-foreground">
                {loadingModel ? 'Switching...' : (currentModel || 'Unknown')}
              </Text>
            </View>
            <Pressable
              onPress={() => setShowModelPicker(!showModelPicker)}
              disabled={loadingModel}
              className={cn(
                'px-4 py-2 rounded-lg',
                loadingModel ? 'bg-muted' : 'bg-primary active:opacity-80',
              )}
            >
              <Text className={cn(
                'text-sm font-medium',
                loadingModel ? 'text-muted-foreground' : 'text-primary-foreground',
              )}>
                {showModelPicker ? 'Cancel' : 'Switch'}
              </Text>
            </Pressable>
          </View>

          {showModelPicker && (
            <View className="mt-2 border-t border-border pt-2">
              {AVAILABLE_MODELS.map((model) => (
                <Pressable
                  key={model.id}
                  onPress={() => switchModel(model.id)}
                  disabled={model.id === currentModel}
                  className={cn(
                    'flex-row items-center justify-between py-2.5 px-3 rounded-lg mb-1',
                    model.id === currentModel ? 'bg-primary/10' : 'active:bg-muted',
                  )}
                >
                  <View>
                    <Text className={cn(
                      'text-sm font-medium',
                      model.id === currentModel ? 'text-primary' : 'text-foreground',
                    )}>
                      {model.label}
                    </Text>
                    <Text className="text-xs text-muted-foreground">{model.provider}</Text>
                  </View>
                  {model.id === currentModel && (
                    <Check size={16} className="text-primary" />
                  )}
                </Pressable>
              ))}
            </View>
          )}
        </SectionCard>
      )}

      <SectionCard title="Agent Controls">
        <ControlButton
          icon={Square}
          label="Stop Agent"
          description="Abort the current agent turn"
          onPress={() => executeAction('Stop Agent', 'POST', '/agent/stop')}
          destructive
        />
        <ControlButton
          icon={RefreshCw}
          label="Reset Session"
          description="Clear agent conversation history"
          onPress={() => executeAction('Reset Session', 'POST', '/agent/session/reset')}
          destructive
        />
        <ControlButton
          icon={Play}
          label="Trigger Heartbeat"
          description="Run a scheduled heartbeat turn"
          onPress={() => executeAction('Heartbeat', 'POST', '/agent/heartbeat/trigger')}
        />
        <ControlButton
          icon={Activity}
          label="Get Agent Mode"
          description="Check current agent interaction mode"
          onPress={async () => {
            const resp = await proxyRequest('GET', '/agent/mode')
            if (resp?.body) {
              try {
                const data = JSON.parse(resp.body)
                setResult(`Agent mode: ${data.mode || JSON.stringify(data)}`)
              } catch { setResult(`Mode: ${resp.body}`) }
            }
          }}
        />
      </SectionCard>

      {!canSwitchModel && (
        <View className="mb-4 p-3 rounded-lg bg-muted/50 border border-border">
          <Text className="text-xs text-muted-foreground">
            Model switching requires a newer desktop app (protocol v2+).
          </Text>
        </View>
      )}

      {result && (
        <View className="mt-4 p-3 rounded-lg bg-muted">
          <Text className="text-sm font-mono text-foreground">{result}</Text>
        </View>
      )}
    </ScrollView>
  )
}

// ─── Audit Tab ──────────────────────────────────────────────────────────────

interface AuditEntry {
  id: string
  action: string
  path?: string
  method?: string
  result?: string
  createdAt: string
}

function AuditTab({
  instanceId,
  headers,
}: {
  instanceId: string
  headers: () => Record<string, string>
}) {
  const [actions, setActions] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/instances/${instanceId}/audit?limit=50`, {
          credentials: 'include',
          headers: headers(),
        })
        if (res.ok) {
          const data = await res.json()
          setActions(data.actions || [])
        }
      } catch {}
      setLoading(false)
    })()
  }, [instanceId, headers])

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  return (
    <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
      {actions.length === 0 ? (
        <View className="items-center py-16">
          <ClipboardList size={32} className="text-muted-foreground/40 mb-3" />
          <Text className="text-sm text-muted-foreground">No remote actions recorded yet</Text>
        </View>
      ) : (
        <View className="gap-2">
          {actions.map((a) => (
            <View key={a.id} className="p-3 rounded-lg border border-border bg-card">
              <View className="flex-row justify-between items-center mb-1">
                <Text className="text-sm font-medium text-foreground">{a.action}</Text>
                <Text className="text-xs text-muted-foreground">
                  {new Date(a.createdAt).toLocaleTimeString()}
                </Text>
              </View>
              {a.path && (
                <Text className="text-xs font-mono text-muted-foreground">
                  {a.method || 'GET'} {a.path}
                </Text>
              )}
              {a.result && (
                <Text className="text-xs text-muted-foreground mt-0.5">{a.result}</Text>
              )}
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  )
}

// ─── Shared Components ──────────────────────────────────────────────────────

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="mb-4 rounded-lg border border-border bg-card overflow-hidden">
      <View className="px-4 py-2.5 border-b border-border bg-muted/50">
        <Text className="text-sm font-medium text-foreground">{title}</Text>
      </View>
      <View className="p-4 gap-2">{children}</View>
    </View>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between items-center">
      <Text className="text-sm text-muted-foreground">{label}</Text>
      <Text className="text-sm font-mono text-foreground">{value}</Text>
    </View>
  )
}

function ControlButton({
  icon: Icon,
  label,
  description,
  onPress,
  destructive,
  disabled,
}: {
  icon: React.ElementType
  label: string
  description: string
  onPress: () => void
  destructive?: boolean
  disabled?: boolean
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className={cn(
        'flex-row items-center p-3 rounded-lg active:bg-muted -mx-1',
        disabled && 'opacity-40',
      )}
    >
      <View className={cn(
        'w-8 h-8 rounded-full items-center justify-center mr-3',
        destructive ? 'bg-destructive/10' : 'bg-primary/10',
      )}>
        <Icon size={16} className={destructive ? 'text-destructive' : 'text-primary'} />
      </View>
      <View className="flex-1">
        <Text className={cn('text-sm font-medium', destructive ? 'text-destructive' : 'text-foreground')}>
          {label}
        </Text>
        <Text className="text-xs text-muted-foreground">{description}</Text>
      </View>
    </Pressable>
  )
}
