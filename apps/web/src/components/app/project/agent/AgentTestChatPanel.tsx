/**
 * AgentTestChatPanel
 *
 * Chat interface for testing the running agent, powered by the AI SDK
 * useChat hook for state management and AssistantContent for rendering
 * (markdown via Streamdown + inline tool call widgets).
 * Loads chat history from the agent runtime on mount.
 */

import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useChat, type UIMessage } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { Send, Bot, User, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AssistantContent } from '../../chat/turns/AssistantContent'

interface AgentTestChatPanelProps {
  projectId: string
  visible: boolean
  localAgentUrl?: string | null
}

/** Extract display text from a UIMessage for user messages. */
function getUserText(msg: UIMessage): string {
  const parts = msg.parts
  if (parts?.length) {
    return parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { type: 'text'; text: string }).text)
      .join('\n')
  }
  const content = (msg as any).content
  return typeof content === 'string' ? content : ''
}

export function AgentTestChatPanel({ projectId, visible, localAgentUrl }: AgentTestChatPanelProps) {
  const [agentUrl, setAgentUrl] = useState<string | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [inputValue, setInputValue] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Resolve agent URL: prefer local desktop runtime, fall back to cloud sandbox
  useEffect(() => {
    if (localAgentUrl) {
      setAgentUrl(localAgentUrl)
      setUrlError(null)
      return
    }

    if (!projectId) return
    let cancelled = false

    ;(async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/sandbox/url`)
        if (!res.ok) throw new Error('Failed to get sandbox URL')
        const data = await res.json()
        if (!cancelled) {
          setAgentUrl(data.agentUrl || data.url)
          setUrlError(null)
        }
      } catch (err: any) {
        if (!cancelled) setUrlError(err.message)
      }
    })()

    return () => { cancelled = true }
  }, [projectId, localAgentUrl])

  const transport = useMemo(() => {
    if (!agentUrl) return null
    return new DefaultChatTransport({ api: `${agentUrl}/agent/chat` })
  }, [agentUrl])

  const {
    messages,
    sendMessage,
    setMessages,
    status,
  } = useChat({
    transport: transport ?? undefined,
    id: `test-${projectId}`,
  })

  const isLoading = status === 'submitted' || status === 'streaming'

  // Load chat history once agent URL is available
  useEffect(() => {
    if (!agentUrl) return
    let cancelled = false

    ;(async () => {
      try {
        const res = await fetch(`${agentUrl}/agent/chat/history`)
        if (!res.ok) return
        const data = await res.json()
        if (cancelled || !data.messages?.length) return

        const initial: UIMessage[] = data.messages.map((m: any) => ({
          id: m.id,
          role: m.role as 'user' | 'assistant',
          parts: [{ type: 'text' as const, text: m.content }],
        }))
        setMessages(initial)
      } catch {
        // History load is best-effort
      }
    })()

    return () => { cancelled = true }
  }, [agentUrl, setMessages])

  // Auto-scroll on new messages or streaming updates
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, status])

  // Focus input when panel becomes visible
  useEffect(() => {
    if (visible && inputRef.current) {
      inputRef.current.focus()
    }
  }, [visible])

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    if (!inputValue.trim() || isLoading || !transport) return
    sendMessage({ text: inputValue })
    setInputValue('')
  }, [inputValue, isLoading, transport, sendMessage])

  const clearChat = useCallback(() => {
    setMessages([])
  }, [setMessages])

  // Determine if the last message is a streaming assistant message
  const lastMsg = messages[messages.length - 1]
  const isStreamingLast = isLoading && lastMsg?.role === 'assistant'

  return (
    <div className={cn('absolute inset-0 flex flex-col', !visible && 'invisible pointer-events-none')}>
      {/* Header */}
      <div className="px-4 py-3 border-b flex items-center gap-2">
        <Bot className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Test your agent</span>
        <span className="text-xs text-muted-foreground ml-auto mr-2">
          Messages go to the running agent
        </span>
        {messages.length > 0 && (
          <button
            onClick={clearChat}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title="Clear chat"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {messages.length === 0 && !urlError && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Send a message to test your agent
          </div>
        )}

        {urlError && (
          <div className="flex items-center justify-center h-full text-destructive text-sm px-4 text-center">
            Could not connect to agent runtime: {urlError}
          </div>
        )}

        {messages.map((msg, idx) => (
          <div
            key={msg.id}
            className={cn(
              'px-4 py-3',
              msg.role === 'user'
                ? 'bg-muted/40'
                : 'bg-background',
            )}
          >
            <div className="flex gap-3 max-w-2xl mx-auto">
              <div
                className={cn(
                  'shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5',
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted border',
                )}
              >
                {msg.role === 'user' ? (
                  <User className="h-3 w-3" />
                ) : (
                  <Bot className="h-3 w-3" />
                )}
              </div>
              <div className="flex-1 min-w-0 text-sm">
                {msg.role === 'user' ? (
                  <div className="whitespace-pre-wrap wrap-break-word pt-0.5">
                    {getUserText(msg)}
                  </div>
                ) : (
                  <AssistantContent
                    message={msg}
                    isStreaming={isStreamingLast && idx === messages.length - 1}
                  />
                )}
              </div>
            </div>
          </div>
        ))}

        {isLoading && lastMsg?.role !== 'assistant' && (
          <div className="px-4 py-3">
            <div className="flex gap-3 max-w-2xl mx-auto">
              <div className="shrink-0 w-6 h-6 rounded-full bg-muted border flex items-center justify-center">
                <Bot className="h-3 w-3" />
              </div>
              <div className="flex items-center gap-1.5 pt-1">
                <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce" />
                <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce [animation-delay:0.15s]" />
                <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce [animation-delay:0.3s]" />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="p-3 border-t bg-background">
        <form onSubmit={handleSubmit} className="flex gap-2 max-w-2xl mx-auto">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={agentUrl ? 'Send a test message…' : 'Connecting to agent…'}
            className="flex-1 rounded-lg border bg-muted/50 px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
            disabled={isLoading || !transport}
          />
          <button
            type="submit"
            disabled={!inputValue.trim() || isLoading || !transport}
            className="rounded-lg bg-primary text-primary-foreground px-3 py-2 text-sm font-medium disabled:opacity-40 hover:bg-primary/90 transition-colors"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>
      </div>
    </div>
  )
}
