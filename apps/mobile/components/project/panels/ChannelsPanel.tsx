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
} from 'lucide-react-native'
import * as Clipboard from 'expo-clipboard'

interface ChannelInfo {
  type: string
  connected: boolean
  error?: string
  metadata?: Record<string, unknown>
}

interface ChannelsPanelProps {
  projectId: string
  agentUrl: string | null
  visible: boolean
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
    setupUrl: '',
    setupLabel: '',
    description: 'Connect any app via Zapier, Make, n8n, or direct HTTP',
    fields: [],
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

export function ChannelsPanel({ projectId, agentUrl, visible }: ChannelsPanelProps) {
  const [channels, setChannels] = useState<ChannelInfo[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedType, setExpandedType] = useState<string | null>(null)
  const [formInputs, setFormInputs] = useState<Record<string, Record<string, string>>>({})
  const [connecting, setConnecting] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [copiedSnippet, setCopiedSnippet] = useState(false)

  const loadChannels = useCallback(async () => {
    if (!agentUrl) return
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch(`${agentUrl}/agent/status`)
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
      const res = await fetch(`${agentUrl}/agent/channels/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, config: inputs }),
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
      const res = await fetch(`${agentUrl}/agent/channels/disconnect`, {
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
                      if (isConnected) return
                      if (!hasForm) return
                      setExpandedType(isExpanded ? null : type)
                      setFormError(null)
                    }}
                    className="px-3 py-2.5 flex-row items-center gap-3 active:bg-muted/50"
                    disabled={isConnected || !hasForm}
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
                          onPress={() => handleDisconnect(type)}
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

                  {/* Expandable config form */}
                  {isExpanded && !isConnected && hasForm && (
                    <View className="px-3 pb-3 border-t border-border">
                      <View className="mt-3 gap-2.5">
                        {def.fields.map(field => (
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
                          </View>
                        ))}

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

            <Text className="text-xs text-muted-foreground mt-4">
              Or ask the builder AI to connect channels. For example: "Connect my Telegram
              bot", "Set up Discord", "Connect WhatsApp", "Add Slack", "Set up a webhook
              channel", "Set up Microsoft Teams", or "Add a webchat widget to my website".
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  )
}
