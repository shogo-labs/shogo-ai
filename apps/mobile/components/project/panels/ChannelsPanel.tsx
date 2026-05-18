// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  TextInput,
  Linking,
} from 'react-native'
import {
  MessageSquare,
  RefreshCw,
  CheckCircle,
  XCircle,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Phone,
} from 'lucide-react-native'
import * as Clipboard from 'expo-clipboard'
import { agentFetch } from '../../../lib/agent-fetch'
import { usePlatformConfig } from '../../../lib/platform-config'
import { API_URL } from '../../../lib/api'
import { PhonePanel } from './PhonePanel'

interface ChannelInfo {
  type: string
  connected: boolean
  error?: string
  model?: string
  metadata?: Record<string, unknown>
}

interface ChannelsPanelProps {
  projectId: string
  /** Workspace owning this project — required for the "Run on" selector
   * to list paired machines. Undefined while the project record is still
   * loading; the selector gracefully no-ops in that case. */
  workspaceId?: string | null
  agentUrl: string | null
  visible: boolean
  hasAdvancedModelAccess?: boolean
}

interface RunOnInstance {
  id: string
  name: string
  hostname: string
  kind: 'desktop' | 'cli_worker' | string
  status: 'online' | 'heartbeat' | 'offline' | string
}

interface RunOnState {
  loading: boolean
  /** `null` instance = cloud-routed (the default). */
  pinnedInstance: RunOnInstance | null
  policy: 'pinned' | 'prefer'
  candidates: RunOnInstance[]
  error: string | null
  saving: boolean
}

interface ChannelField {
  key: string
  label: string
  placeholder: string
  secret: boolean
}

interface ChannelDef {
  name: string
  emoji: string
  setupUrl: string
  setupLabel: string
  description?: string
  fields: ChannelField[]
}

const CHANNEL_DEFS: Record<string, ChannelDef> = {
  telegram: {
    name: 'Telegram',
    emoji: '📱',
    setupUrl: 'https://core.telegram.org/bots#botfather',
    setupLabel: 'Create bot via @BotFather',
    fields: [
      { key: 'botToken', label: 'Bot Token', placeholder: 'Paste token from @BotFather', secret: true },
    ],
  },
  discord: {
    name: 'Discord',
    emoji: '🎮',
    setupUrl: 'https://discord.com/developers/applications',
    setupLabel: 'Discord Developer Portal',
    fields: [
      { key: 'botToken', label: 'Bot Token', placeholder: 'Bot token from Developer Portal', secret: true },
      { key: 'guildId', label: 'Guild ID (optional)', placeholder: 'Right-click server → Copy Server ID', secret: false },
    ],
  },
  slack: {
    name: 'Slack',
    emoji: '💼',
    setupUrl: 'https://api.slack.com/apps',
    setupLabel: 'Slack App Dashboard',
    fields: [
      { key: 'botToken', label: 'Bot Token (xoxb-...)', placeholder: 'xoxb-...', secret: true },
      { key: 'appToken', label: 'App Token (xapp-...)', placeholder: 'xapp-...', secret: true },
    ],
  },
  whatsapp: {
    name: 'WhatsApp',
    emoji: '💬',
    setupUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started',
    setupLabel: 'Meta WhatsApp Setup',
    fields: [
      { key: 'accessToken', label: 'Access Token', placeholder: 'From Meta Business', secret: true },
      { key: 'phoneNumberId', label: 'Phone Number ID', placeholder: 'From WhatsApp API setup', secret: false },
    ],
  },
  email: {
    name: 'Email (IMAP/SMTP)',
    emoji: '📧',
    setupUrl: 'https://support.google.com/mail/answer/7126229',
    setupLabel: 'Email setup guide',
    fields: [
      { key: 'imapHost', label: 'IMAP Host', placeholder: 'imap.gmail.com', secret: false },
      { key: 'smtpHost', label: 'SMTP Host', placeholder: 'smtp.gmail.com', secret: false },
      { key: 'username', label: 'Username', placeholder: 'user@example.com', secret: false },
      { key: 'password', label: 'Password', placeholder: 'App password', secret: true },
    ],
  },
  webhook: {
    name: 'Webhook / HTTP',
    emoji: '🔗',
    setupUrl: 'https://docs.shogo.ai/docs/features/external-triggers/webhook-channel',
    setupLabel: 'Webhook channel docs',
    description: 'Trigger this agent from Jira, Linear, Zapier, n8n, or any HTTP client',
    fields: [
      // Shared secret — when set, external callers must supply it as
      // `X-Webhook-Secret` (forwarded through the cloud agent-proxy to
      // `WebhookAdapter.verifyAuth`). When blank, the runtime accepts
      // every inbound request that already passed cloud auth (workspace
      // membership + `shogo_sk_*` Bearer). Leaving it blank is allowed
      // but discouraged for any externally-reachable channel — the
      // empty-secret warning rendered below the input nudges the user
      // toward setting one. See:
      //   - apps/docs/.../external-triggers/webhook-channel.md
      //   - apps/api/src/lib/agent-proxy-headers.ts
      //   - packages/agent-runtime/src/channels/webhook.ts:verifyAuth
      { key: 'secret', label: 'Shared Secret', placeholder: 'A long random string (e.g. openssl rand -hex 32)', secret: true },
      // Optional default callback URL — if set, every reply gets POSTed
      // back there instead of (or in addition to) returning synchronously.
      { key: 'callbackUrl', label: 'Default Callback URL (optional)', placeholder: 'https://your-app.example.com/agent-reply', secret: false },
    ],
  },
  teams: {
    name: 'Microsoft Teams',
    emoji: '🟦',
    setupUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    setupLabel: 'Azure App Registrations',
    fields: [],
  },
  webchat: {
    name: 'WebChat Widget',
    emoji: '🌐',
    setupUrl: '',
    setupLabel: '',
    description: 'Embeddable chat widget for any website',
    fields: [
      { key: 'title', label: 'Chat Title (optional)', placeholder: 'Chat with us', secret: false },
      { key: 'welcomeMessage', label: 'Welcome Message (optional)', placeholder: 'Hi! How can I help you today?', secret: false },
      { key: 'primaryColor', label: 'Theme Color (optional)', placeholder: '#6366f1', secret: false },
      { key: 'position', label: 'Position (optional)', placeholder: 'bottom-right or bottom-left', secret: false },
      { key: 'allowedOrigins', label: 'Allowed Origins (optional)', placeholder: '* (all) or https://example.com', secret: false },
    ],
  },
}

export function ChannelsPanel({ projectId, workspaceId, agentUrl, visible, hasAdvancedModelAccess = false }: ChannelsPanelProps) {
  const { features } = usePlatformConfig()
  const [channels, setChannels] = useState<ChannelInfo[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedType, setExpandedType] = useState<string | null>(null)
  const [formInputs, setFormInputs] = useState<Record<string, Record<string, string>>>({})
  const [modelSelection, setModelSelection] = useState<Record<string, 'basic' | 'advanced'>>({})
  const [connecting, setConnecting] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
  const [savingModel, setSavingModel] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [copiedSnippet, setCopiedSnippet] = useState(false)
  const [copiedWebhookUrl, setCopiedWebhookUrl] = useState(false)
  const [phoneExpanded, setPhoneExpanded] = useState(false)

  /**
   * Canonical, externally-callable webhook URL for this project.
   *
   * This stays stable regardless of where the agent actually runs (cloud
   * pod or a paired VPS via `client.machines.pinProject`), which is the
   * whole point of the project-scoped agent-proxy. We compose it from the
   * cloud `API_URL` and `projectId` directly — NOT from `agentUrl`, which
   * may already be wrapped in `/api/instances/:id/p/` when the user has
   * an active remote-instance selection. That wrapped form is a
   * power-user escape hatch, never the URL you paste into Jira.
   *
   * See: apps/docs/docs/features/external-triggers/webhook-channel.md
   */
  const publicWebhookUrl = API_URL
    ? `${API_URL.replace(/\/$/, '')}/api/projects/${projectId}/agent-proxy/agent/channels/webhook/incoming`
    : null

  // ── "Run on" routing ──────────────────────────────────────────────
  // Reads `Project.preferredInstanceId` and offers a picker over the
  // workspace's paired machines (desktops + `shogo worker` CLI sign-ins).
  // The selection persists server-side; from then on every external call
  // to `publicWebhookUrl` (or any other agent-proxy path) is relayed
  // through that machine's tunnel.
  const [runOn, setRunOn] = useState<RunOnState>({
    loading: false,
    pinnedInstance: null,
    policy: 'pinned',
    candidates: [],
    error: null,
    saving: false,
  })
  const [runOnPickerOpen, setRunOnPickerOpen] = useState(false)

  const loadRunOn = useCallback(async () => {
    if (!visible || !API_URL || !workspaceId) return
    setRunOn((prev) => ({ ...prev, loading: true, error: null }))
    try {
      const [pinRes, instancesRes] = await Promise.all([
        fetch(`${API_URL}/api/projects/${projectId}/preferred-instance`, { credentials: 'include' }),
        fetch(`${API_URL}/api/instances?workspaceId=${encodeURIComponent(workspaceId)}`, { credentials: 'include' }),
      ])
      if (!pinRes.ok) throw new Error(`pin: ${pinRes.status}`)
      if (!instancesRes.ok) throw new Error(`instances: ${instancesRes.status}`)
      const pin = await pinRes.json()
      const list = (await instancesRes.json()) as { instances?: RunOnInstance[] }
      setRunOn({
        loading: false,
        pinnedInstance: pin.instance ?? null,
        policy: (pin.preferredInstancePolicy ?? 'pinned') as 'pinned' | 'prefer',
        candidates: list.instances ?? [],
        error: null,
        saving: false,
      })
    } catch (err: any) {
      setRunOn((prev) => ({ ...prev, loading: false, error: err?.message ?? 'Failed to load' }))
    }
  }, [projectId, workspaceId, visible])

  useEffect(() => {
    loadRunOn()
  }, [loadRunOn])

  const setPin = useCallback(
    async (instanceId: string | null) => {
      if (!API_URL) return
      setRunOn((prev) => ({ ...prev, saving: true, error: null }))
      try {
        const url = `${API_URL}/api/projects/${projectId}/preferred-instance`
        const res = instanceId
          ? await fetch(url, {
              method: 'PUT',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ instanceId, policy: 'pinned' }),
            })
          : await fetch(url, { method: 'DELETE', credentials: 'include' })
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
        }
        setRunOnPickerOpen(false)
        await loadRunOn()
      } catch (err: any) {
        setRunOn((prev) => ({ ...prev, saving: false, error: err?.message ?? 'Failed to save' }))
      }
    },
    [projectId, loadRunOn],
  )

  const loadChannels = useCallback(async () => {
    if (!agentUrl) return
    setIsLoading(true)
    setError(null)
    try {
      const res = await agentFetch(`${agentUrl}/agent/status`)
      if (!res.ok) throw new Error('Agent not reachable')
      const data = await res.json()
      setChannels(data.channels || [])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }, [agentUrl])

  useEffect(() => {
    if (visible) loadChannels()
  }, [visible, loadChannels])

  const handleConnect = useCallback(async (type: string) => {
    if (!agentUrl) return
    const def = CHANNEL_DEFS[type]
    if (!def) return

    const inputs = formInputs[type] || {}
    const requiredFields = def.fields.filter(f => !f.label.includes('optional'))
    const missing = requiredFields.filter(f => !inputs[f.key]?.trim())
    if (missing.length > 0) {
      setFormError(`Required: ${missing.map(f => f.label).join(', ')}`)
      return
    }

    setConnecting(type)
    setFormError(null)
    try {
      const model = modelSelection[type] || 'basic'
      const res = await agentFetch(`${agentUrl}/agent/channels/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, config: inputs, model }),
      })

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || `Failed to connect ${type}`)
      }

      setExpandedType(null)
      setFormInputs(prev => {
        const next = { ...prev }
        delete next[type]
        return next
      })
      setModelSelection(prev => {
        const next = { ...prev }
        delete next[type]
        return next
      })
      await loadChannels()
    } catch (err: any) {
      setFormError(err.message)
    } finally {
      setConnecting(null)
    }
  }, [agentUrl, formInputs, loadChannels])

  const handleDisconnect = useCallback(async (type: string) => {
    if (!agentUrl) return
    setDisconnecting(type)
    setFormError(null)
    try {
      const res = await agentFetch(`${agentUrl}/agent/channels/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
      })

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || `Failed to disconnect ${type}`)
      }

      await loadChannels()
    } catch (err: any) {
      setFormError(err.message)
    } finally {
      setDisconnecting(null)
    }
  }, [agentUrl, loadChannels])

  const handleModelUpdate = useCallback(async (type: string) => {
    if (!agentUrl) return
    const model = modelSelection[type]
    if (!model) return

    setSavingModel(type)
    setFormError(null)
    try {
      const res = await agentFetch(`${agentUrl}/agent/channels/${type}/model`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update model')
      }
      setExpandedType(null)
      setModelSelection(prev => {
        const next = { ...prev }
        delete next[type]
        return next
      })
      await loadChannels()
    } catch (err: any) {
      setFormError(err.message)
    } finally {
      setSavingModel(null)
    }
  }, [agentUrl, modelSelection, loadChannels])

  const updateInput = (type: string, key: string, value: string) => {
    setFormInputs(prev => ({
      ...prev,
      [type]: { ...prev[type], [key]: value },
    }))
  }

  if (!visible) return null

  const connectedTypes = new Set(channels.map(ch => ch.type))

  return (
    <View className="absolute inset-0 flex-col" style={{ display: visible ? 'flex' : 'none' }}>
      <View className="px-4 py-3 border-b border-border flex-row items-center gap-2">
        <MessageSquare size={16} className="text-muted-foreground" />
        <View className="flex-1">
          <View className="flex-row items-center gap-2">
            <Text className="text-sm font-medium text-foreground">Channels</Text>
            <Text className="text-xs text-muted-foreground">
              {channels.filter((c) => c.connected).length} connected
            </Text>
          </View>
          <Text className="text-[10px] text-muted-foreground">
            Configure below or ask the agent to set up for you
          </Text>
        </View>
        <Pressable onPress={loadChannels} className="p-1 rounded-md active:bg-muted">
          <RefreshCw size={14} className="text-muted-foreground" />
        </Pressable>
      </View>

      {/* "Run on" routing — pin this project to a paired machine so all
          external triggers (webhooks, scheduled jobs) land there instead
          of a cloud pod. See features/external-triggers/quickstart.md. */}
      {workspaceId && (
        <View className="px-4 py-2 border-b border-border">
          <View className="flex-row items-center gap-2">
            <Text className="text-[11px] text-muted-foreground">Run on:</Text>
            <Pressable
              onPress={() => setRunOnPickerOpen((open) => !open)}
              className="flex-1 flex-row items-center gap-1.5 px-2 py-1 border border-border rounded-md active:bg-muted"
              disabled={runOn.loading || runOn.saving}
            >
              <Text className="text-xs text-foreground flex-1" numberOfLines={1}>
                {runOn.loading
                  ? 'Loading…'
                  : runOn.pinnedInstance
                    ? runOn.pinnedInstance.name
                    : 'Cloud (default)'}
              </Text>
              {(runOn.loading || runOn.saving) ? (
                <ActivityIndicator size="small" />
              ) : (
                <ChevronDown size={12} className="text-muted-foreground" />
              )}
            </Pressable>
            {runOn.pinnedInstance && !runOn.saving && (
              <Pressable
                onPress={() => setPin(null)}
                className="px-2 py-1 border border-border rounded-md active:bg-muted"
              >
                <Text className="text-[10px] text-muted-foreground">Unpin</Text>
              </Pressable>
            )}
          </View>
          {runOn.error && (
            <Text className="text-[10px] text-destructive mt-1">{runOn.error}</Text>
          )}
          {runOnPickerOpen && (
            <View className="mt-2 border border-border rounded-md overflow-hidden">
              {/* Cloud (unpin) option — always available. */}
              <Pressable
                onPress={() => setPin(null)}
                className="px-3 py-2 flex-row items-center gap-2 active:bg-muted"
              >
                <View className="flex-1">
                  <Text className="text-xs text-foreground">Cloud (default)</Text>
                  <Text className="text-[10px] text-muted-foreground">
                    Shogo cold-starts a runtime pod on demand
                  </Text>
                </View>
                {!runOn.pinnedInstance && <Check size={12} className="text-emerald-500" />}
              </Pressable>
              {runOn.candidates.length === 0 ? (
                <View className="px-3 py-3 border-t border-border">
                  <Text className="text-[10px] text-muted-foreground">
                    No paired machines yet. Run{' '}
                    <Text className="font-mono text-foreground">shogo worker start</Text> on a
                    VPS or laptop to pair one.
                  </Text>
                </View>
              ) : (
                runOn.candidates.map((inst) => {
                  const selected = runOn.pinnedInstance?.id === inst.id
                  const offline = inst.status === 'offline'
                  return (
                    <Pressable
                      key={inst.id}
                      onPress={() => !offline && setPin(inst.id)}
                      disabled={offline}
                      className="px-3 py-2 flex-row items-center gap-2 border-t border-border active:bg-muted"
                      style={offline ? { opacity: 0.5 } : undefined}
                    >
                      <View
                        className={`h-2 w-2 rounded-full ${
                          inst.status === 'online'
                            ? 'bg-emerald-500'
                            : inst.status === 'heartbeat'
                              ? 'bg-yellow-500'
                              : 'bg-muted-foreground/40'
                        }`}
                      />
                      <View className="flex-1">
                        <Text className="text-xs text-foreground">{inst.name}</Text>
                        <Text className="text-[10px] text-muted-foreground">
                          {inst.kind === 'cli_worker' ? 'Worker' : 'Desktop'} · {inst.hostname}
                          {offline ? ' · offline' : ''}
                        </Text>
                      </View>
                      {selected && <Check size={12} className="text-emerald-500" />}
                    </Pressable>
                  )
                })
              )}
            </View>
          )}
        </View>
      )}

      {error && (
        <View className="px-4 py-2 bg-destructive/10">
          <Text className="text-xs text-destructive">{error}</Text>
        </View>
      )}

      <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
        {isLoading && channels.length === 0 ? (
          <View className="items-center py-8">
            <ActivityIndicator size="small" />
          </View>
        ) : (
          <View className="gap-2">
            {Object.entries(CHANNEL_DEFS).map(([type, def]) => {
              const liveChannel = channels.find(ch => ch.type === type)
              const isConnected = liveChannel?.connected ?? false
              const hasError = liveChannel && !liveChannel.connected && liveChannel.error
              const isExpanded = expandedType === type
              const isConnecting = connecting === type
              const isDisconnecting = disconnecting === type
              const hasForm = def.fields.length > 0

              return (
                <View key={type} className="border border-border rounded-lg overflow-hidden">
                  {/* Channel header row */}
                  <Pressable
                    onPress={() => {
                      if (!isConnected && !hasForm) return
                      setExpandedType(isExpanded ? null : type)
                      setFormError(null)
                    }}
                    className="px-3 py-2.5 flex-row items-center gap-3 active:bg-muted/50"
                    disabled={!isConnected && !hasForm}
                  >
                    <Text
                      className="text-lg"
                      style={!isConnected && !connectedTypes.has(type) ? { opacity: 0.5 } : undefined}
                    >
                      {def.emoji}
                    </Text>
                    <View className="flex-1">
                      <Text
                        className={`text-sm font-medium ${isConnected ? 'text-foreground' : 'text-muted-foreground'}`}
                      >
                        {def.name}
                      </Text>
                      {hasError && (
                        <Text className="text-xs text-destructive">{liveChannel.error}</Text>
                      )}
                      {!isConnected && !hasForm && def.description && (
                        <Text className="text-xs text-muted-foreground">{def.description}</Text>
                      )}
                    </View>

                    {isConnected ? (
                      <View className="flex-row items-center gap-2">
                        <CheckCircle size={16} className="text-emerald-500" />
                        <Pressable
                          onPress={(e) => {
                            e.stopPropagation?.()
                            handleDisconnect(type)
                          }}
                          disabled={isDisconnecting}
                          className="px-2 py-0.5 border border-border rounded active:bg-destructive/10"
                          style={isDisconnecting ? { opacity: 0.5 } : undefined}
                        >
                          {isDisconnecting ? (
                            <ActivityIndicator size="small" />
                          ) : (
                            <Text className="text-[10px] text-muted-foreground">Disconnect</Text>
                          )}
                        </Pressable>
                        {isExpanded ? (
                          <ChevronDown size={14} className="text-muted-foreground" />
                        ) : (
                          <ChevronRight size={14} className="text-muted-foreground" />
                        )}
                      </View>
                    ) : hasForm ? (
                      isExpanded ? (
                        <ChevronDown size={14} className="text-muted-foreground" />
                      ) : (
                        <ChevronRight size={14} className="text-muted-foreground" />
                      )
                    ) : def.setupUrl ? (
                      <Pressable
                        onPress={() => Linking.openURL(def.setupUrl)}
                        className="p-1 rounded-md active:bg-muted"
                      >
                        <ExternalLink size={14} className="text-muted-foreground" />
                      </Pressable>
                    ) : null}
                  </Pressable>

                  {/* Webhook public URL — visible whenever the user opens
                      the channel, even before connecting, so they can wire
                      external services in parallel. */}
                  {type === 'webhook' && isExpanded && publicWebhookUrl && (
                    <View className="px-3 pb-3 border-t border-border">
                      <View className="mt-3 gap-2">
                        <Text className="text-[11px] font-medium text-foreground">
                          Public webhook URL
                        </Text>
                        <Text className="text-[10px] text-muted-foreground">
                          Paste this into Jira, Linear, Zapier, n8n, or any caller. Always
                          send <Text className="font-mono">Authorization: Bearer shogo_sk_…</Text>{' '}
                          plus <Text className="font-mono">X-Webhook-Secret</Text> with the
                          secret below.
                        </Text>
                        <View className="bg-muted/50 rounded-md p-2.5 border border-border">
                          <Text className="text-[10px] text-foreground font-mono" selectable>
                            {publicWebhookUrl}
                          </Text>
                        </View>
                        <View className="flex-row items-center gap-2">
                          <Pressable
                            onPress={async () => {
                              await Clipboard.setStringAsync(publicWebhookUrl)
                              setCopiedWebhookUrl(true)
                              setTimeout(() => setCopiedWebhookUrl(false), 2000)
                            }}
                            className="flex-row items-center gap-1.5 px-2.5 py-1.5 border border-border rounded-md active:bg-muted"
                          >
                            {copiedWebhookUrl ? (
                              <>
                                <Check size={12} className="text-emerald-500" />
                                <Text className="text-[10px] text-emerald-500">Copied!</Text>
                              </>
                            ) : (
                              <>
                                <Copy size={12} className="text-muted-foreground" />
                                <Text className="text-[10px] text-muted-foreground">Copy URL</Text>
                              </>
                            )}
                          </Pressable>
                          <Pressable
                            onPress={() => Linking.openURL('https://docs.shogo.ai/docs/features/external-triggers/quickstart')}
                            className="flex-row items-center gap-1.5 px-2.5 py-1.5 border border-border rounded-md active:bg-muted"
                          >
                            <ExternalLink size={12} className="text-muted-foreground" />
                            <Text className="text-[10px] text-muted-foreground">Quickstart</Text>
                          </Pressable>
                        </View>
                      </View>
                    </View>
                  )}

                  {/* WebChat embed snippet (shown when connected) */}
                  {type === 'webchat' && isConnected && agentUrl && (
                    <View className="px-3 pb-3 border-t border-border">
                      <View className="mt-3 gap-2">
                        <Text className="text-[11px] font-medium text-foreground">
                          Embed on your website
                        </Text>
                        <Text className="text-[10px] text-muted-foreground">
                          Copy this snippet and paste it before the closing {'</body>'} tag:
                        </Text>
                        <View className="bg-muted/50 rounded-md p-2.5 border border-border">
                          <Text
                            className="text-[10px] text-foreground font-mono"
                            selectable
                          >
                            {`<script src="${agentUrl}/agent/channels/webchat/widget.js"></script>`}
                          </Text>
                        </View>
                        <Pressable
                          onPress={async () => {
                            const snippet = `<script src="${agentUrl}/agent/channels/webchat/widget.js"></script>`
                            await Clipboard.setStringAsync(snippet)
                            setCopiedSnippet(true)
                            setTimeout(() => setCopiedSnippet(false), 2000)
                          }}
                          className="flex-row items-center gap-1.5 self-start px-2.5 py-1.5 border border-border rounded-md active:bg-muted"
                        >
                          {copiedSnippet ? (
                            <>
                              <Check size={12} className="text-emerald-500" />
                              <Text className="text-[10px] text-emerald-500">Copied!</Text>
                            </>
                          ) : (
                            <>
                              <Copy size={12} className="text-muted-foreground" />
                              <Text className="text-[10px] text-muted-foreground">Copy snippet</Text>
                            </>
                          )}
                        </Pressable>
                      </View>
                    </View>
                  )}

                  {/* Model selector for connected channels */}
                  {isExpanded && isConnected && (
                    <View className="px-3 pb-3 border-t border-border">
                      <View className="mt-3 gap-2.5">
                        <View>
                          <Text className="text-[11px] text-muted-foreground mb-1">
                            AI Model
                          </Text>
                          <View className="flex-row gap-2">
                            <Pressable
                              onPress={() => setModelSelection(prev => ({ ...prev, [type]: 'basic' }))}
                              className={`flex-1 px-2.5 py-2 rounded-md border ${
                                (modelSelection[type] || liveChannel?.model || 'basic') === 'basic'
                                  ? 'border-primary bg-primary/10'
                                  : 'border-border bg-background'
                              }`}
                            >
                              <Text className={`text-xs font-medium ${
                                (modelSelection[type] || liveChannel?.model || 'basic') === 'basic' ? 'text-primary' : 'text-foreground'
                              }`}>
                                Basic
                              </Text>
                              <Text className="text-[10px] text-muted-foreground mt-0.5">
                                Economy tier — all plans
                              </Text>
                            </Pressable>
                            <Pressable
                              onPress={() => {
                                if (hasAdvancedModelAccess) {
                                  setModelSelection(prev => ({ ...prev, [type]: 'advanced' }))
                                }
                              }}
                              disabled={!hasAdvancedModelAccess}
                              className={`flex-1 px-2.5 py-2 rounded-md border ${
                                !hasAdvancedModelAccess
                                  ? 'border-border bg-muted/30 opacity-50'
                                  : (modelSelection[type] || liveChannel?.model) === 'advanced'
                                    ? 'border-primary bg-primary/10'
                                    : 'border-border bg-background'
                              }`}
                            >
                              <Text className={`text-xs font-medium ${
                                !hasAdvancedModelAccess
                                  ? 'text-muted-foreground'
                                  : (modelSelection[type] || liveChannel?.model) === 'advanced' ? 'text-primary' : 'text-foreground'
                              }`}>
                                Advanced
                              </Text>
                              <Text className="text-[10px] text-muted-foreground mt-0.5">
                                {hasAdvancedModelAccess ? 'Standard tier — Pro plan' : 'Requires Pro plan'}
                              </Text>
                            </Pressable>
                          </View>
                        </View>

                        {formError && expandedType === type && (
                          <View className="bg-destructive/10 rounded px-2 py-1.5">
                            <Text className="text-xs text-destructive">{formError}</Text>
                          </View>
                        )}

                        {modelSelection[type] && modelSelection[type] !== (liveChannel?.model || 'basic') && (
                          <Pressable
                            onPress={() => handleModelUpdate(type)}
                            disabled={savingModel === type}
                            className="self-start px-3 py-1.5 bg-primary rounded-md active:bg-primary/80"
                            style={savingModel === type ? { opacity: 0.5 } : undefined}
                          >
                            <View className="flex-row items-center gap-1.5">
                              {savingModel === type && <ActivityIndicator size="small" color="#fff" />}
                              <Text className="text-xs text-primary-foreground">Save</Text>
                            </View>
                          </Pressable>
                        )}
                      </View>
                    </View>
                  )}

                  {/* Expandable config form */}
                  {isExpanded && !isConnected && hasForm && (
                    <View className="px-3 pb-3 border-t border-border">
                      <View className="mt-3 gap-2.5">
                        {def.fields.map(field => {
                          // Empty shared-secret warning for the webhook channel.
                          // The runtime accepts every inbound request that
                          // already passed cloud auth when `secret` is blank
                          // (see WebhookAdapter.verifyAuth) — that means any
                          // workspace member can trigger the channel, which
                          // is rarely what a user setting up an external
                          // integration actually wants. Nudge them toward
                          // setting one without forcing it (legitimate
                          // dev/CI use cases exist).
                          const showEmptyWebhookSecretWarning =
                            type === 'webhook' &&
                            field.key === 'secret' &&
                            !(formInputs[type]?.[field.key] || '').trim()
                          return (
                            <View key={field.key}>
                              <Text className="text-[11px] text-muted-foreground mb-1">
                                {field.label}
                              </Text>
                              <TextInput
                                secureTextEntry={field.secret}
                                placeholder={field.placeholder}
                                placeholderTextColor="#666"
                                value={formInputs[type]?.[field.key] || ''}
                                onChangeText={(text) => updateInput(type, field.key, text)}
                                className="px-2.5 py-1.5 text-xs border border-border rounded-md bg-background text-foreground"
                              />
                              {showEmptyWebhookSecretWarning && (
                                <Text className="text-[10px] text-amber-600 dark:text-amber-500 mt-1">
                                  Leaving this blank lets any workspace member with a Shogo API key trigger this channel. Recommended for production: a long random string (e.g. <Text className="font-mono">openssl rand -hex 32</Text>).
                                </Text>
                              )}
                            </View>
                          )
                        })}

                        <View>
                          <Text className="text-[11px] text-muted-foreground mb-1">
                            AI Model
                          </Text>
                          <View className="flex-row gap-2">
                            <Pressable
                              onPress={() => setModelSelection(prev => ({ ...prev, [type]: 'basic' }))}
                              className={`flex-1 px-2.5 py-2 rounded-md border ${
                                (modelSelection[type] || 'basic') === 'basic'
                                  ? 'border-primary bg-primary/10'
                                  : 'border-border bg-background'
                              }`}
                            >
                              <Text className={`text-xs font-medium ${
                                (modelSelection[type] || 'basic') === 'basic' ? 'text-primary' : 'text-foreground'
                              }`}>
                                Basic
                              </Text>
                              <Text className="text-[10px] text-muted-foreground mt-0.5">
                                Economy tier — all plans
                              </Text>
                            </Pressable>
                            <Pressable
                              onPress={() => {
                                if (hasAdvancedModelAccess) {
                                  setModelSelection(prev => ({ ...prev, [type]: 'advanced' }))
                                }
                              }}
                              disabled={!hasAdvancedModelAccess}
                              className={`flex-1 px-2.5 py-2 rounded-md border ${
                                !hasAdvancedModelAccess
                                  ? 'border-border bg-muted/30 opacity-50'
                                  : (modelSelection[type]) === 'advanced'
                                    ? 'border-primary bg-primary/10'
                                    : 'border-border bg-background'
                              }`}
                            >
                              <Text className={`text-xs font-medium ${
                                !hasAdvancedModelAccess
                                  ? 'text-muted-foreground'
                                  : (modelSelection[type]) === 'advanced' ? 'text-primary' : 'text-foreground'
                              }`}>
                                Advanced
                              </Text>
                              <Text className="text-[10px] text-muted-foreground mt-0.5">
                                {hasAdvancedModelAccess ? 'Standard tier — Pro plan' : 'Requires Pro plan'}
                              </Text>
                            </Pressable>
                          </View>
                        </View>

                        {formError && expandedType === type && (
                          <View className="bg-destructive/10 rounded px-2 py-1.5">
                            <Text className="text-xs text-destructive">{formError}</Text>
                          </View>
                        )}

                        <View className="flex-row items-center gap-2 pt-1">
                          <Pressable
                            onPress={() => handleConnect(type)}
                            disabled={isConnecting}
                            className="px-3 py-1.5 bg-primary rounded-md active:bg-primary/80"
                            style={isConnecting ? { opacity: 0.5 } : undefined}
                          >
                            <View className="flex-row items-center gap-1.5">
                              {isConnecting && <ActivityIndicator size="small" color="#fff" />}
                              <Text className="text-xs text-primary-foreground">Connect</Text>
                            </View>
                          </Pressable>
                          <Pressable
                            onPress={() => {
                              setExpandedType(null)
                              setFormError(null)
                            }}
                            className="px-3 py-1.5 border border-border rounded-md active:bg-muted"
                          >
                            <Text className="text-xs text-foreground">Cancel</Text>
                          </Pressable>
                          {def.setupUrl ? (
                            <Pressable
                              onPress={() => Linking.openURL(def.setupUrl)}
                              className="ml-auto flex-row items-center gap-1 active:opacity-70"
                            >
                              <ExternalLink size={12} className="text-muted-foreground" />
                              <Text className="text-[10px] text-muted-foreground">
                                {def.setupLabel}
                              </Text>
                            </Pressable>
                          ) : null}
                        </View>
                      </View>
                    </View>
                  )}
                </View>
              )
            })}

            {/* Phone (Voice) — Twilio + ElevenLabs, provisioned by Shogo.
                Gated by the `phoneChannel` super-admin feature flag. */}
            {features.phoneChannel && (
              <View className="border border-border rounded-lg overflow-hidden">
                <Pressable
                  onPress={() => setPhoneExpanded((v) => !v)}
                  className="px-3 py-2.5 flex-row items-center gap-3 active:bg-muted/50"
                >
                  <Phone size={18} className="text-muted-foreground" />
                  <View className="flex-1">
                    <Text className="text-sm font-medium text-foreground">
                      Phone (Voice)
                    </Text>
                    <Text className="text-xs text-muted-foreground">
                      Inbound + outbound PSTN calls that bridge to this project's
                      ElevenLabs agent
                    </Text>
                  </View>
                  {phoneExpanded ? (
                    <ChevronDown size={14} className="text-muted-foreground" />
                  ) : (
                    <ChevronRight size={14} className="text-muted-foreground" />
                  )}
                </Pressable>
                {phoneExpanded && (
                  <View className="px-3 py-3 border-t border-border">
                    <PhonePanel
                      projectId={projectId}
                      visible={phoneExpanded}
                      embedded
                    />
                  </View>
                )}
              </View>
            )}

            <Text className="text-xs text-muted-foreground mt-4">
              Or ask the builder AI to connect channels. For example: "Connect my Telegram
              bot", "Set up Discord", "Connect WhatsApp", "Add Slack", "Set up a webhook
              channel", "Set up Microsoft Teams", "Add a webchat widget to my website",
              or "Get me a phone number".
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  )
}
