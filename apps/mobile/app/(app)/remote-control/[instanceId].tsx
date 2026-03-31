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
  TextInput,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { cn } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../../contexts/auth'
import { API_URL } from '../../../lib/api'
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
}

interface ProxyResponse {
  status: number
  headers?: Record<string, string>
  body?: string
}

type Tab = 'status' | 'chat' | 'files' | 'controls'

export default function InstanceDetailScreen() {
  const { instanceId } = useLocalSearchParams<{ instanceId: string }>()
  const router = useRouter()
  const { session } = useAuth()
  const [instance, setInstance] = useState<InstanceDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<Tab>('status')

  const headers = useCallback(() => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (Platform.OS !== 'web' && session?.token) {
      h.Cookie = `better-auth.session_token=${session.token}`
    }
    return h
  }, [session?.token])

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
      return await res.json()
    } catch {
      return null
    }
  }, [instanceId, headers])

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

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="px-4 pt-4 pb-3 border-b border-border">
        <View className="flex-row items-center gap-3">
          <Pressable onPress={() => router.back()} className="p-1 rounded-md active:bg-muted">
            <ArrowLeft size={20} className="text-foreground" />
          </Pressable>
          <View className="flex-1">
            <View className="flex-row items-center gap-2">
              <Text className="text-lg font-bold text-foreground">{instance.name}</Text>
              {isOnline ? (
                <Wifi size={16} className="text-green-500" />
              ) : (
                <WifiOff size={16} className="text-muted-foreground" />
              )}
            </View>
            <Text className="text-xs text-muted-foreground">
              {instance.hostname} · {instance.os || 'unknown'}/{instance.arch || '?'}
            </Text>
          </View>
        </View>

        {/* Tabs */}
        <View className="flex-row gap-1 mt-3">
          {([
            { key: 'status' as Tab, label: 'Status', icon: Activity },
            { key: 'chat' as Tab, label: 'Chat', icon: MessageSquare },
            { key: 'files' as Tab, label: 'Files', icon: FolderTree },
            { key: 'controls' as Tab, label: 'Controls', icon: Settings },
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

      {/* Tab Content */}
      {!isOnline ? (
        <View className="flex-1 items-center justify-center p-8">
          <WifiOff size={48} className="text-muted-foreground/40 mb-4" />
          <Text className="text-lg font-medium text-foreground mb-2">Instance Offline</Text>
          <Text className="text-sm text-muted-foreground text-center">
            This instance is not currently connected. Start the local Shogo server with a Shogo API key to reconnect.
          </Text>
        </View>
      ) : (
        <>
          {activeTab === 'status' && <StatusTab instance={instance} proxyRequest={proxyRequest} />}
          {activeTab === 'chat' && <ChatTab instanceId={instanceId!} headers={headers} />}
          {activeTab === 'files' && <FilesTab instanceId={instanceId!} proxyRequest={proxyRequest} />}
          {activeTab === 'controls' && <ControlsTab instanceId={instanceId!} proxyRequest={proxyRequest} />}
        </>
      )}
    </View>
  )
}

// ─── Status Tab ─────────────────────────────────────────────────────────────

function StatusTab({
  instance,
  proxyRequest,
}: {
  instance: InstanceDetail
  proxyRequest: (method: string, path: string) => Promise<ProxyResponse | null>
}) {
  const [agentStatus, setAgentStatus] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      const resp = await proxyRequest('GET', '/agent/status')
      if (resp?.body) {
        try { setAgentStatus(JSON.parse(resp.body)) } catch {}
      }
      setLoading(false)
    })()
  }, [proxyRequest])

  const meta = instance.metadata as any

  return (
    <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
      <SectionCard title="Instance Info">
        <InfoRow label="Hostname" value={instance.hostname} />
        <InfoRow label="OS" value={`${instance.os || '?'} / ${instance.arch || '?'}`} />
        <InfoRow label="Uptime" value={meta?.uptime ? `${Math.floor(meta.uptime / 60)}m` : 'Unknown'} />
        <InfoRow label="API Port" value={String(meta?.apiPort || '?')} />
        <InfoRow label="Active Projects" value={String(meta?.activeProjects ?? '?')} />
      </SectionCard>

      {meta?.projects && Array.isArray(meta.projects) && meta.projects.length > 0 && (
        <SectionCard title="Projects">
          {meta.projects.map((p: any, i: number) => (
            <InfoRow key={i} label={p.projectId?.slice(0, 8) || `Project ${i + 1}`} value={p.status || 'unknown'} />
          ))}
        </SectionCard>
      )}

      <SectionCard title="Agent Runtime">
        {loading ? (
          <ActivityIndicator size="small" />
        ) : agentStatus ? (
          <>
            <InfoRow label="Status" value={String((agentStatus as any).status || 'unknown')} />
            <InfoRow label="Mode" value={String((agentStatus as any).mode || 'unknown')} />
            {(agentStatus as any).channels && (
              <InfoRow label="Channels" value={String(Object.keys((agentStatus as any).channels).length)} />
            )}
          </>
        ) : (
          <Text className="text-sm text-muted-foreground">Could not fetch agent status</Text>
        )}
      </SectionCard>
    </ScrollView>
  )
}

// ─── Chat Tab ───────────────────────────────────────────────────────────────

function ChatTab({
  instanceId,
  headers,
}: {
  instanceId: string
  headers: () => Record<string, string>
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
    } finally {
      setSending(false)
    }
  }, [input, sending, instanceId, headers])

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
}: {
  instanceId: string
  proxyRequest: (method: string, path: string, body?: string) => Promise<ProxyResponse | null>
}) {
  const [result, setResult] = useState<string | null>(null)

  const executeAction = useCallback(async (label: string, method: string, path: string, body?: string) => {
    setResult(`Executing: ${label}...`)
    const resp = await proxyRequest(method, path, body)
    if (resp) {
      setResult(`${label}: ${resp.status === 200 ? 'Success' : `HTTP ${resp.status}`}`)
    } else {
      setResult(`${label}: Failed`)
    }
  }, [proxyRequest])

  return (
    <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
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

      {result && (
        <View className="mt-4 p-3 rounded-lg bg-muted">
          <Text className="text-sm font-mono text-foreground">{result}</Text>
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
}: {
  icon: React.ElementType
  label: string
  description: string
  onPress: () => void
  destructive?: boolean
}) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center p-3 rounded-lg active:bg-muted -mx-1"
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
