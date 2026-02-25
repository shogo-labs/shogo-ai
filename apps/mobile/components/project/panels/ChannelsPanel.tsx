import { useState, useEffect, useCallback } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator, Linking } from 'react-native'
import { MessageSquare, RefreshCw, CheckCircle, XCircle, ExternalLink } from 'lucide-react-native'

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

const CHANNEL_META: Record<string, { name: string; emoji: string; setupUrl: string }> = {
  telegram: {
    name: 'Telegram',
    emoji: '📱',
    setupUrl: 'https://core.telegram.org/bots#botfather',
  },
  discord: {
    name: 'Discord',
    emoji: '🎮',
    setupUrl: 'https://discord.com/developers/applications',
  },
  email: {
    name: 'Email (IMAP/SMTP)',
    emoji: '📧',
    setupUrl: 'https://support.google.com/mail/answer/7126229',
  },
  whatsapp: {
    name: 'WhatsApp',
    emoji: '💬',
    setupUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started',
  },
  slack: {
    name: 'Slack',
    emoji: '💼',
    setupUrl: 'https://api.slack.com/apps',
  },
}

export function ChannelsPanel({ projectId, agentUrl, visible }: ChannelsPanelProps) {
  const [channels, setChannels] = useState<ChannelInfo[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  if (!visible) return null

  const connectedTypes = new Set(channels.map((c) => c.type))

  return (
    <View className="absolute inset-0 flex-col" style={{ display: visible ? 'flex' : 'none' }}>
      <View className="px-4 py-3 border-b border-border flex-row items-center gap-2">
        <MessageSquare size={16} className="text-muted-foreground" />
        <Text className="text-sm font-medium text-foreground">Channels</Text>
        <Text className="text-xs text-muted-foreground">
          {channels.filter((c) => c.connected).length} connected
        </Text>
        <Pressable onPress={loadChannels} className="ml-auto p-1 rounded-md active:bg-muted">
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
          </View>
        ) : (
          <View className="gap-4">
            {channels.length > 0 && (
              <View className="gap-2">
                <Text className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Connected
                </Text>
                {channels.map((ch, i) => {
                  const meta = CHANNEL_META[ch.type] || { name: ch.type, emoji: '📡' }
                  return (
                    <View
                      key={i}
                      className="border border-border rounded-lg p-3 flex-row items-center gap-3"
                    >
                      <Text className="text-lg">{meta.emoji}</Text>
                      <View className="flex-1">
                        <Text className="text-sm font-medium text-foreground">{meta.name}</Text>
                        {ch.error && (
                          <Text className="text-xs text-destructive">{ch.error}</Text>
                        )}
                      </View>
                      {ch.connected ? (
                        <CheckCircle size={16} className="text-emerald-500" />
                      ) : (
                        <XCircle size={16} className="text-destructive" />
                      )}
                    </View>
                  )
                })}
              </View>
            )}

            <View className="gap-2">
              <Text className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Available Channels
              </Text>
              {Object.entries(CHANNEL_META).map(([type, meta]) => {
                if (connectedTypes.has(type)) return null
                return (
                  <View
                    key={type}
                    className="border border-dashed border-border rounded-lg p-3 flex-row items-center gap-3"
                  >
                    <Text className="text-lg opacity-50">{meta.emoji}</Text>
                    <View className="flex-1">
                      <Text className="text-sm font-medium text-muted-foreground">{meta.name}</Text>
                      <Text className="text-xs text-muted-foreground/70">
                        Not connected — ask the builder AI to set up
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => Linking.openURL(meta.setupUrl)}
                      className="p-1 rounded-md active:bg-muted"
                    >
                      <ExternalLink size={14} className="text-muted-foreground" />
                    </Pressable>
                  </View>
                )
              })}
            </View>

            <Text className="text-xs text-muted-foreground mt-2">
              Use the builder AI chat to connect channels. For example: "Connect my Telegram
              bot", "Set up Discord", "Connect WhatsApp", or "Add Slack".
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  )
}
