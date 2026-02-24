/**
 * AgentChannelsPanel
 *
 * Dashboard for connected messaging channels.
 * Each channel type has an expandable config form so users can
 * input credentials and connect/disconnect directly from the UI.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  MessageSquare, RefreshCw, CheckCircle, XCircle,
  ExternalLink, ChevronDown, ChevronRight, Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAgentUrl } from '@/hooks/useAgentUrl'

interface ChannelInfo {
  type: string
  connected: boolean
  error?: string
  metadata?: Record<string, unknown>
}

interface AgentChannelsPanelProps {
  projectId: string
  visible: boolean
  localAgentUrl?: string | null
}

interface ChannelField {
  key: string
  label: string
  placeholder: string
  secret: boolean
}

interface ChannelDef {
  name: string
  icon: string
  setupUrl: string
  setupLabel: string
  fields: ChannelField[]
}

const CHANNEL_DEFS: Record<string, ChannelDef> = {
  telegram: {
    name: 'Telegram',
    icon: '📱',
    setupUrl: 'https://core.telegram.org/bots#botfather',
    setupLabel: 'Create bot via @BotFather',
    fields: [
      { key: 'botToken', label: 'Bot Token', placeholder: 'Paste token from @BotFather', secret: true },
    ],
  },
  discord: {
    name: 'Discord',
    icon: '🎮',
    setupUrl: 'https://discord.com/developers/applications',
    setupLabel: 'Discord Developer Portal',
    fields: [
      { key: 'botToken', label: 'Bot Token', placeholder: 'Bot token from Developer Portal', secret: true },
      { key: 'guildId', label: 'Guild ID (optional)', placeholder: 'Right-click server → Copy Server ID', secret: false },
    ],
  },
  slack: {
    name: 'Slack',
    icon: '💬',
    setupUrl: 'https://api.slack.com/apps',
    setupLabel: 'Slack App Dashboard',
    fields: [
      { key: 'botToken', label: 'Bot Token (xoxb-...)', placeholder: 'xoxb-...', secret: true },
      { key: 'appToken', label: 'App Token (xapp-...)', placeholder: 'xapp-...', secret: true },
    ],
  },
  whatsapp: {
    name: 'WhatsApp',
    icon: '📲',
    setupUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started',
    setupLabel: 'Meta WhatsApp Setup',
    fields: [
      { key: 'accessToken', label: 'Access Token', placeholder: 'From Meta Business', secret: true },
      { key: 'phoneNumberId', label: 'Phone Number ID', placeholder: 'From WhatsApp API setup', secret: false },
    ],
  },
  email: {
    name: 'Email (IMAP/SMTP)',
    icon: '📧',
    setupUrl: 'https://support.google.com/mail/answer/7126229',
    setupLabel: 'Email setup guide',
    fields: [
      { key: 'imapHost', label: 'IMAP Host', placeholder: 'imap.gmail.com', secret: false },
      { key: 'smtpHost', label: 'SMTP Host', placeholder: 'smtp.gmail.com', secret: false },
      { key: 'username', label: 'Username', placeholder: 'user@example.com', secret: false },
      { key: 'password', label: 'Password', placeholder: 'App password', secret: true },
    ],
  },
}

export function AgentChannelsPanel({ projectId, visible, localAgentUrl }: AgentChannelsPanelProps) {
  const [channels, setChannels] = useState<ChannelInfo[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedType, setExpandedType] = useState<string | null>(null)
  const [formInputs, setFormInputs] = useState<Record<string, Record<string, string>>>({})
  const [connecting, setConnecting] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const { refetch: getAgentUrl } = useAgentUrl(projectId, localAgentUrl)

  const loadChannels = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const baseUrl = await getAgentUrl()
      const res = await fetch(`${baseUrl}/agent/status`)
      if (!res.ok) throw new Error('Agent not reachable')
      const data = await res.json()
      setChannels(data.channels || [])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }, [getAgentUrl])

  useEffect(() => {
    if (visible) loadChannels()
  }, [visible, loadChannels])

  const handleConnect = useCallback(async (type: string) => {
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
      const baseUrl = await getAgentUrl()
      const res = await fetch(`${baseUrl}/agent/channels/connect`, {
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
  }, [formInputs, getAgentUrl, loadChannels])

  const handleDisconnect = useCallback(async (type: string) => {
    setDisconnecting(type)
    setFormError(null)
    try {
      const baseUrl = await getAgentUrl()
      const res = await fetch(`${baseUrl}/agent/channels/disconnect`, {
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
  }, [getAgentUrl, loadChannels])

  const updateInput = (type: string, key: string, value: string) => {
    setFormInputs(prev => ({
      ...prev,
      [type]: { ...prev[type], [key]: value },
    }))
  }

  const connectedTypes = new Set(channels.map(ch => ch.type))

  return (
    <div className={cn('absolute inset-0 flex flex-col', !visible && 'invisible pointer-events-none')}>
      <div className="px-4 py-3 border-b flex items-center gap-2">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Channels</span>
            <span className="text-xs text-muted-foreground">
              {channels.filter((c) => c.connected).length} connected
            </span>
          </div>
          <span className="text-[10px] text-muted-foreground/70">
            Configure below or ask the agent to set up for you
          </span>
        </div>
        <button
          onClick={loadChannels}
          className="ml-auto p-1 rounded hover:bg-muted text-muted-foreground"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 bg-destructive/10 text-destructive text-xs">{error}</div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {isLoading && channels.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-8">Loading...</div>
        ) : (
          <div className="space-y-2">
            {Object.entries(CHANNEL_DEFS).map(([type, def]) => {
              const liveChannel = channels.find(ch => ch.type === type)
              const isConnected = liveChannel?.connected ?? false
              const hasError = liveChannel && !liveChannel.connected && liveChannel.error
              const isExpanded = expandedType === type
              const isConnecting = connecting === type
              const isDisconnecting = disconnecting === type

              return (
                <div key={type} className="border rounded-lg overflow-hidden">
                  {/* Channel header */}
                  <button
                    onClick={() => {
                      if (isConnected) return
                      setExpandedType(isExpanded ? null : type)
                      setFormError(null)
                    }}
                    className={cn(
                      'w-full px-3 py-2.5 flex items-center gap-3 transition-colors',
                      !isConnected && 'hover:bg-muted/50 cursor-pointer',
                      isConnected && 'cursor-default',
                    )}
                  >
                    <span className={cn('text-lg', !isConnected && !connectedTypes.has(type) && 'opacity-50')}>
                      {def.icon}
                    </span>
                    <div className="flex-1 text-left">
                      <div className={cn('text-sm font-medium', !isConnected && 'text-muted-foreground')}>
                        {def.name}
                      </div>
                      {hasError && (
                        <div className="text-xs text-destructive">{liveChannel.error}</div>
                      )}
                    </div>

                    {isConnected ? (
                      <div className="flex items-center gap-2">
                        <CheckCircle className="h-4 w-4 text-green-500" />
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleDisconnect(type)
                          }}
                          disabled={isDisconnecting}
                          className="px-2 py-0.5 text-[10px] border rounded hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors disabled:opacity-50"
                        >
                          {isDisconnecting ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            'Disconnect'
                          )}
                        </button>
                      </div>
                    ) : (
                      <>
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </>
                    )}
                  </button>

                  {/* Expandable config form */}
                  {isExpanded && !isConnected && (
                    <div className="px-3 pb-3 border-t">
                      <div className="mt-3 space-y-2.5">
                        {def.fields.map(field => (
                          <div key={field.key}>
                            <label className="text-[11px] text-muted-foreground block mb-1">
                              {field.label}
                            </label>
                            <input
                              type={field.secret ? 'password' : 'text'}
                              placeholder={field.placeholder}
                              value={formInputs[type]?.[field.key] || ''}
                              onChange={(e) => updateInput(type, field.key, e.target.value)}
                              className="w-full px-2.5 py-1.5 text-xs border rounded-md bg-background focus:outline-none focus:ring-1 focus:ring-primary/50"
                            />
                          </div>
                        ))}

                        {formError && expandedType === type && (
                          <div className="text-xs text-destructive bg-destructive/10 rounded px-2 py-1.5">
                            {formError}
                          </div>
                        )}

                        <div className="flex items-center gap-2 pt-1">
                          <button
                            onClick={() => handleConnect(type)}
                            disabled={isConnecting}
                            className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1.5"
                          >
                            {isConnecting && <Loader2 className="h-3 w-3 animate-spin" />}
                            Connect
                          </button>
                          <button
                            onClick={() => {
                              setExpandedType(null)
                              setFormError(null)
                            }}
                            className="px-3 py-1.5 text-xs border rounded-md hover:bg-muted"
                          >
                            Cancel
                          </button>
                          <a
                            href={def.setupUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <ExternalLink className="h-3 w-3" />
                            {def.setupLabel}
                          </a>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}

            <div className="text-xs text-muted-foreground mt-4">
              Or ask the builder AI to connect channels. For example: &quot;Connect my Telegram bot&quot;, &quot;Set up Discord&quot;, &quot;Connect WhatsApp&quot;, or &quot;Add Slack&quot;.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
