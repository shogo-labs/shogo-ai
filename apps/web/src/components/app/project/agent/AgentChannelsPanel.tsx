/**
 * AgentChannelsPanel
 *
 * Dashboard for connected messaging channels.
 * Shows status, connection details, setup instructions,
 * and for Webhook channels: endpoint URL, test button, and activity log.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  MessageSquare,
  RefreshCw,
  CheckCircle,
  XCircle,
  ExternalLink,
  Send,
  Copy,
  Check,
  Clock,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Zap,
  Activity,
} from 'lucide-react'

function cn(...classes: (string | boolean | undefined | null)[]) {
  return classes.filter(Boolean).join(' ')
}

interface ChannelInfo {
  type: string
  connected: boolean
  error?: string
  metadata?: Record<string, unknown>
}

interface WebhookActivityEntry {
  id: string
  timestamp: string
  direction: 'inbound' | 'outbound'
  senderId: string
  senderName: string
  messagePreview: string
  replyPreview?: string
  status: 'success' | 'pending' | 'error' | 'timeout'
  durationMs?: number
}

interface AgentChannelsPanelProps {
  projectId: string
  visible: boolean
  agentUrl?: string | null
}

const CHANNEL_INFO: Record<string, { name: string; icon: string; setupUrl: string; description?: string }> = {
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
  slack: {
    name: 'Slack',
    icon: '💼',
    setupUrl: 'https://api.slack.com/apps',
  },
  webhook: {
    name: 'Webhook / HTTP',
    icon: '🔗',
    setupUrl: '',
    description: 'Connect any app via Zapier, Make, n8n, or direct HTTP',
  },
  teams: {
    name: 'Microsoft Teams',
    icon: '🟦',
    setupUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
  },
  webchat: {
    name: 'WebChat Widget',
    icon: '🌐',
    setupUrl: '',
    description: 'Embeddable chat widget for any website',
  },
}

function timeAgo(isoString: string): string {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string; icon: React.ReactNode }> = {
    success: { label: 'Success', className: 'bg-green-500/10 text-green-500 border-green-500/20', icon: <CheckCircle className="h-3 w-3" /> },
    pending: { label: 'Pending', className: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20', icon: <Clock className="h-3 w-3 animate-spin" /> },
    error: { label: 'Error', className: 'bg-red-500/10 text-red-500 border-red-500/20', icon: <XCircle className="h-3 w-3" /> },
    timeout: { label: 'Timeout', className: 'bg-orange-500/10 text-orange-500 border-orange-500/20', icon: <AlertCircle className="h-3 w-3" /> },
  }
  const info = map[status] || map.error
  return (
    <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border', info.className)}>
      {info.icon}
      {info.label}
    </span>
  )
}

function WebhookDetails({
  channel,
  baseUrl,
}: {
  channel: ChannelInfo
  baseUrl: string
}) {
  const [testMessage, setTestMessage] = useState('Hello! This is a test.')
  const [isTesting, setIsTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; reply?: string; error?: string } | null>(null)
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [showActivity, setShowActivity] = useState(true)
  const [activity, setActivity] = useState<WebhookActivityEntry[]>([])
  const [messageCount, setMessageCount] = useState(0)
  const activityIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const metadata = channel.metadata as Record<string, any> | undefined
  const hasSecret = metadata?.hasSecret || metadata?.authenticated
  const endpointUrl = `${baseUrl}/agent/channels/webhook/incoming`

  const loadActivity = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/agent/channels/webhook/activity`)
      if (res.ok) {
        const data = await res.json()
        setActivity(data.activity || [])
        setMessageCount(data.messageCount || 0)
      }
    } catch {
      // Silently fail
    }
  }, [baseUrl])

  useEffect(() => {
    loadActivity()
    activityIntervalRef.current = setInterval(loadActivity, 5000)
    return () => {
      if (activityIntervalRef.current) clearInterval(activityIntervalRef.current)
    }
  }, [loadActivity])

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text)
    setCopiedField(field)
    setTimeout(() => setCopiedField(null), 2000)
  }

  const sendTest = async () => {
    setIsTesting(true)
    setTestResult(null)
    try {
      const res = await fetch(`${baseUrl}/agent/channels/webhook/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: testMessage }),
      })
      const data = await res.json()
      if (res.ok) {
        setTestResult({ ok: true, reply: data.reply })
      } else {
        setTestResult({ ok: false, error: data.error || 'Test failed' })
      }
      loadActivity()
    } catch (err: any) {
      setTestResult({ ok: false, error: err.message })
    } finally {
      setIsTesting(false)
    }
  }

  const curlExample = hasSecret
    ? `curl -X POST ${endpointUrl} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_SECRET" \\
  -d '{"message": "Hello agent!"}'`
    : `curl -X POST ${endpointUrl} \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Hello agent!"}'`

  return (
    <div className="space-y-3 mt-3">
      {/* Endpoint URL */}
      <div className="bg-muted/50 rounded-lg p-3 space-y-2">
        <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          Endpoint URL
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs bg-background rounded px-2 py-1.5 font-mono text-foreground break-all border">
            {endpointUrl}
          </code>
          <button
            onClick={() => copyToClipboard(endpointUrl, 'url')}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground shrink-0"
            title="Copy URL"
          >
            {copiedField === 'url' ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>

        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            {hasSecret ? (
              <><CheckCircle className="h-3 w-3 text-green-500" /> Secret configured</>
            ) : (
              <><AlertCircle className="h-3 w-3 text-yellow-500" /> No auth (open)</>
            )}
          </span>
          <span className="text-muted-foreground/50">&bull;</span>
          <span>{messageCount} messages received</span>
        </div>
      </div>

      {/* Test webhook */}
      <div className="bg-muted/50 rounded-lg p-3 space-y-2">
        <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <Zap className="h-3 w-3" />
          Send Test Message
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={testMessage}
            onChange={(e) => setTestMessage(e.target.value)}
            placeholder="Type a test message..."
            className="flex-1 text-xs bg-background rounded px-2 py-1.5 border focus:outline-none focus:ring-1 focus:ring-primary"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isTesting) sendTest()
            }}
          />
          <button
            onClick={sendTest}
            disabled={isTesting || !testMessage.trim()}
            className={cn(
              'px-3 py-1.5 rounded text-xs font-medium flex items-center gap-1.5 shrink-0 transition-colors',
              isTesting
                ? 'bg-muted text-muted-foreground cursor-wait'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            )}
          >
            {isTesting ? (
              <><RefreshCw className="h-3 w-3 animate-spin" /> Testing...</>
            ) : (
              <><Send className="h-3 w-3" /> Send</>
            )}
          </button>
        </div>

        {testResult && (
          <div
            className={cn(
              'text-xs rounded p-2 border',
              testResult.ok
                ? 'bg-green-500/5 border-green-500/20 text-green-700 dark:text-green-400'
                : 'bg-red-500/5 border-red-500/20 text-red-700 dark:text-red-400'
            )}
          >
            {testResult.ok ? (
              <div>
                <span className="font-medium">Agent replied:</span>
                <div className="mt-1 text-foreground whitespace-pre-wrap">{testResult.reply}</div>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <XCircle className="h-3.5 w-3.5 shrink-0" />
                {testResult.error}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Curl example */}
      <div className="bg-muted/50 rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Example Request
          </div>
          <button
            onClick={() => copyToClipboard(curlExample, 'curl')}
            className="p-1 rounded hover:bg-muted text-muted-foreground"
            title="Copy curl command"
          >
            {copiedField === 'curl' ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
        <pre className="text-[11px] bg-zinc-950 text-zinc-300 rounded p-2.5 font-mono overflow-x-auto whitespace-pre-wrap break-all">
          {curlExample}
        </pre>
      </div>

      {/* Activity log */}
      <div className="bg-muted/50 rounded-lg overflow-hidden">
        <button
          onClick={() => setShowActivity(!showActivity)}
          className="w-full flex items-center justify-between p-3 hover:bg-muted/70 transition-colors"
        >
          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <Activity className="h-3 w-3" />
            Recent Activity
            {activity.length > 0 && (
              <span className="bg-primary/10 text-primary px-1.5 py-0.5 rounded-full text-[10px]">
                {activity.length}
              </span>
            )}
          </div>
          {showActivity ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
        </button>

        {showActivity && (
          <div className="border-t max-h-64 overflow-y-auto">
            {activity.length === 0 ? (
              <div className="px-3 py-6 text-xs text-muted-foreground text-center">
                No webhook activity yet. Send a test message or call the endpoint from an external app.
              </div>
            ) : (
              <div className="divide-y divide-border/50">
                {[...activity].reverse().map((entry) => (
                  <div key={entry.id} className="px-3 py-2 hover:bg-muted/30 transition-colors">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[10px]">
                          {entry.direction === 'inbound' ? '📥' : '📤'}
                        </span>
                        <span className="text-[11px] font-medium text-foreground truncate">
                          {entry.senderName}
                        </span>
                        <StatusBadge status={entry.status} />
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground shrink-0">
                        {entry.durationMs != null && (
                          <span>{entry.durationMs < 1000 ? `${entry.durationMs}ms` : `${(entry.durationMs / 1000).toFixed(1)}s`}</span>
                        )}
                        <span>{timeAgo(entry.timestamp)}</span>
                      </div>
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground truncate pl-5">
                      {entry.messagePreview}
                    </div>
                    {entry.replyPreview && (
                      <div className="mt-0.5 text-[11px] text-foreground/70 truncate pl-5">
                        &rarr; {entry.replyPreview}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function WebChatDetails({ baseUrl }: { baseUrl: string }) {
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const widgetUrl = `${baseUrl}/agent/channels/webchat/widget.js`
  const embedSnippet = `<script src="${widgetUrl}"></script>`

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text)
    setCopiedField(field)
    setTimeout(() => setCopiedField(null), 2000)
  }

  return (
    <div className="space-y-3 mt-3">
      <div className="bg-muted/50 rounded-lg p-3 space-y-2">
        <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          Embed on Your Website
        </div>
        <p className="text-[11px] text-muted-foreground">
          Copy this snippet and paste it before the closing <code>&lt;/body&gt;</code> tag on any page:
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs bg-background rounded px-2 py-1.5 font-mono text-foreground break-all border">
            {embedSnippet}
          </code>
          <button
            onClick={() => copyToClipboard(embedSnippet, 'snippet')}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground shrink-0"
            title="Copy snippet"
          >
            {copiedField === 'snippet' ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      <div className="bg-muted/50 rounded-lg p-3 space-y-2">
        <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          Widget Script URL
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs bg-background rounded px-2 py-1.5 font-mono text-foreground break-all border">
            {widgetUrl}
          </code>
          <button
            onClick={() => copyToClipboard(widgetUrl, 'url')}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground shrink-0"
            title="Copy URL"
          >
            {copiedField === 'url' ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      <div className="bg-muted/50 rounded-lg p-3 space-y-2">
        <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          Test It
        </div>
        <p className="text-[11px] text-muted-foreground">
          Open the widget health check to verify it's running:
        </p>
        <a
          href={`${baseUrl}/agent/channels/webchat/health`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
        >
          <ExternalLink className="h-3 w-3" />
          Health Check
        </a>
      </div>
    </div>
  )
}

export function AgentChannelsPanel({ projectId, visible, agentUrl }: AgentChannelsPanelProps) {
  const [channels, setChannels] = useState<ChannelInfo[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedChannel, setExpandedChannel] = useState<string | null>(null)
  const [agentBaseUrl, setAgentBaseUrl] = useState<string | null>(null)
  const hasAutoExpanded = useRef(false)

  const loadChannels = useCallback(async () => {
    if (!agentUrl) return
    setIsLoading(true)
    setError(null)
    try {
      const baseUrl = agentUrl
      setAgentBaseUrl(baseUrl)

      const res = await fetch(`${baseUrl}/agent/status`)
      if (!res.ok) throw new Error('Agent not reachable')
      const data = await res.json()
      setChannels(data.channels || [])

      if (!hasAutoExpanded.current) {
        const webhookConnected = (data.channels || []).some(
          (c: ChannelInfo) => c.type === 'webhook' && c.connected
        )
        const webchatConnected = (data.channels || []).some(
          (c: ChannelInfo) => c.type === 'webchat' && c.connected
        )
        if (webchatConnected) {
          setExpandedChannel('webchat')
          hasAutoExpanded.current = true
        } else if (webhookConnected) {
          setExpandedChannel('webhook')
          hasAutoExpanded.current = true
        }
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }, [agentUrl])

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
            {channels.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Connected
                </div>
                {channels.map((ch, i) => {
                  const info = CHANNEL_INFO[ch.type] || { name: ch.type, icon: '📡' }
                  const isExpanded = expandedChannel === ch.type
                  const hasDetails = ch.type === 'webhook' || ch.type === 'webchat'

                  return (
                    <div key={i} className="border rounded-lg overflow-hidden">
                      <div
                        className={cn(
                          'p-3 flex items-center gap-3',
                          hasDetails && 'cursor-pointer hover:bg-muted/30 transition-colors'
                        )}
                        onClick={() => {
                          if (hasDetails) setExpandedChannel(isExpanded ? null : ch.type)
                        }}
                      >
                        <span className="text-lg">{info.icon}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium">{info.name}</div>
                          {ch.error && (
                            <div className="text-xs text-destructive">{ch.error}</div>
                          )}
                          {ch.type === 'webhook' && ch.connected && !isExpanded && (
                            <div className="text-[11px] text-muted-foreground mt-0.5">
                              {(ch.metadata as any)?.messageCount || 0} messages &bull; Click to expand
                            </div>
                          )}
                          {ch.type === 'webchat' && ch.connected && !isExpanded && (
                            <div className="text-[11px] text-muted-foreground mt-0.5">
                              {(ch.metadata as any)?.activeSessions || 0} sessions &bull; Click for embed code
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          {ch.connected ? (
                            <CheckCircle className="h-4 w-4 text-green-500" />
                          ) : (
                            <XCircle className="h-4 w-4 text-destructive" />
                          )}
                          {hasDetails && (
                            isExpanded
                              ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                              : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </div>
                      </div>

                      {isExpanded && ch.type === 'webhook' && agentBaseUrl && (
                        <div className="border-t px-3 pb-3">
                          <WebhookDetails channel={ch} baseUrl={agentBaseUrl} />
                        </div>
                      )}
                      {isExpanded && ch.type === 'webchat' && agentBaseUrl && (
                        <div className="border-t px-3 pb-3">
                          <WebChatDetails baseUrl={agentBaseUrl} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

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
                        {info.description || 'Not connected — ask the builder AI to set up'}
                      </div>
                    </div>
                    {info.setupUrl && (
                      <a
                        href={info.setupUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1 rounded hover:bg-muted text-muted-foreground"
                        title="Setup guide"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="text-xs text-muted-foreground mt-4">
              Use the builder AI chat to connect channels. For example: &quot;Connect my Telegram bot&quot;, &quot;Set up Discord&quot;, &quot;Connect WhatsApp&quot;, &quot;Add Slack&quot;, &quot;Set up a webhook channel&quot;, &quot;Set up Microsoft Teams&quot;, or &quot;Add a webchat widget to my website&quot;.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
