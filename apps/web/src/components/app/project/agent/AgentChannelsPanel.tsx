/**
 * AgentChannelsPanel
 *
 * Dashboard for connected messaging channels.
 * Shows status, connection details, and setup instructions.
 */

import { useState, useEffect, useCallback } from 'react'
import { MessageSquare, RefreshCw, CheckCircle, XCircle, ExternalLink } from 'lucide-react'
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

const CHANNEL_INFO: Record<string, { name: string; icon: string; setupUrl: string }> = {
  telegram: {
    name: 'Telegram',
    icon: '📱',
    setupUrl: 'https://core.telegram.org/bots#botfather',
  },
  discord: {
    name: 'Discord',
    icon: '🎮',
    setupUrl: 'https://discord.com/developers/applications',
  },
  email: {
    name: 'Email (IMAP/SMTP)',
    icon: '📧',
    setupUrl: 'https://support.google.com/mail/answer/7126229',
  },
  whatsapp: {
    name: 'WhatsApp',
    icon: '💬',
    setupUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started',
  },
}

export function AgentChannelsPanel({ projectId, visible, localAgentUrl }: AgentChannelsPanelProps) {
  const [channels, setChannels] = useState<ChannelInfo[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
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

  return (
    <div className={cn('absolute inset-0 flex flex-col', !visible && 'invisible pointer-events-none')}>
      <div className="px-4 py-3 border-b flex items-center gap-2">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Channels</span>
        <span className="text-xs text-muted-foreground">
          {channels.filter((c) => c.connected).length} connected
        </span>
        <button
          onClick={loadChannels}
          className="ml-auto p-1 rounded hover:bg-muted text-muted-foreground"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 bg-destructive/10 text-destructive text-xs">{error}</div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="text-sm text-muted-foreground text-center py-8">Loading...</div>
        ) : (
          <div className="space-y-4">
            {/* Connected channels */}
            {channels.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Connected
                </div>
                {channels.map((ch, i) => {
                  const info = CHANNEL_INFO[ch.type] || { name: ch.type, icon: '📡' }
                  return (
                    <div key={i} className="border rounded-lg p-3 flex items-center gap-3">
                      <span className="text-lg">{info.icon}</span>
                      <div className="flex-1">
                        <div className="text-sm font-medium">{info.name}</div>
                        {ch.error && (
                          <div className="text-xs text-destructive">{ch.error}</div>
                        )}
                      </div>
                      {ch.connected ? (
                        <CheckCircle className="h-4 w-4 text-green-500" />
                      ) : (
                        <XCircle className="h-4 w-4 text-destructive" />
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Available channels */}
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Available Channels
              </div>
              {Object.entries(CHANNEL_INFO).map(([type, info]) => {
                const isConnected = channels.some((c) => c.type === type)
                if (isConnected) return null
                return (
                  <div key={type} className="border border-dashed rounded-lg p-3 flex items-center gap-3">
                    <span className="text-lg opacity-50">{info.icon}</span>
                    <div className="flex-1">
                      <div className="text-sm font-medium text-muted-foreground">{info.name}</div>
                      <div className="text-xs text-muted-foreground/70">
                        Not connected — ask the builder AI to set up
                      </div>
                    </div>
                    <a
                      href={info.setupUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1 rounded hover:bg-muted text-muted-foreground"
                      title="Setup guide"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </div>
                )
              })}
            </div>

            <div className="text-xs text-muted-foreground mt-4">
              Use the builder AI chat to connect channels. For example: "Connect my Telegram bot", "Set up Discord integration", or "Connect WhatsApp".
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
