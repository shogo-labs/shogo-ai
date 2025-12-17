/**
 * FeatureChatPanel - Chat panel integrated with feature sessions
 *
 * Uses AI SDK useChat hook for streaming, displays tool calls via ToolCallPart,
 * and persists messages to chatDomain linked to feature sessions.
 */

import { useState, useEffect, useRef } from "react"
import { observer } from "mobx-react-lite"
import { useChat, type Message } from "@ai-sdk/react"
import { useDomains } from "@/contexts/DomainProvider"
import { ToolCallPart, type ToolCallState } from "./ToolCallPart"
import { cn } from "@/lib/utils"

interface FeatureChatPanelProps {
  featureSessionId: string | null
  featureSessionName: string | null
  onSkillInvoked?: (skillName: string) => void
}

export const FeatureChatPanel = observer(function FeatureChatPanel({
  featureSessionId,
  featureSessionName,
  onSkillInvoked,
}: FeatureChatPanelProps) {
  const { chat } = useDomains()
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  // Find or create chat session for this feature session
  // Use direct filter as fallback in case view method isn't available yet (HMR)
  const chatSession = featureSessionId
    ? (chat.chatSessionCollection.findByFeatureSessionId?.(featureSessionId) ??
       chat.chatSessionCollection.all().find((s: any) => s.featureSessionId === featureSessionId))
    : null

  // AI SDK useChat hook
  const {
    messages,
    input,
    setInput,
    handleSubmit,
    isLoading,
    error: chatError,
    setMessages,
  } = useChat({
    api: "/api/chat",
    id: chatSession?.id || undefined,
    streamProtocol: "text",
    onFinish: async (message) => {
      if (chatSession?.id) {
        const assistantMessage = chat.addMessage({
          sessionId: chatSession.id,
          role: "assistant",
          content: message.content,
        })
        await chat.chatMessageCollection.saveOne(assistantMessage.id)
      }
    },
    onError: (error) => {
      console.error("[FeatureChatPanel] Chat error:", error)
    },
  })

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // Load persisted messages when session changes
  useEffect(() => {
    if (chatSession?.id) {
      const persistedMessages = chat.chatMessageCollection.findBySession(
        chatSession.id
      )
      if (persistedMessages.length > 0) {
        const aiMessages = persistedMessages.map((msg: any) => ({
          id: msg.id,
          role: msg.role as "user" | "assistant",
          content: msg.content,
        }))
        setMessages(aiMessages)
      } else {
        setMessages([])
      }
    } else {
      setMessages([])
    }
  }, [chatSession?.id, chat.chatMessageCollection, setMessages])

  // Create chat session when feature session is selected but no chat exists
  const ensureChatSession = async () => {
    if (featureSessionId && !chatSession) {
      const newSession = chat.createChatSession({
        name: featureSessionName || `Chat for ${featureSessionId}`,
        featureSessionId,
      })
      await chat.chatSessionCollection.saveOne(newSession.id)
      return newSession
    }
    return chatSession
  }

  // Handle form submission
  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!featureSessionId || !input.trim() || isLoading) return

    setLocalError(null)

    // Ensure we have a chat session
    const session = await ensureChatSession()
    if (!session) {
      setLocalError("Failed to create chat session")
      return
    }

    // Persist user message
    const userMessage = chat.addMessage({
      sessionId: session.id,
      role: "user",
      content: input.trim(),
    })
    await chat.chatMessageCollection.saveOne(userMessage.id)

    // Detect skill invocation in message
    const skillMatch = input.match(/platform-feature-(\w+)/i)
    if (skillMatch) {
      onSkillInvoked?.(skillMatch[1])
    }

    // Let AI SDK handle submission
    handleSubmit(e)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleFormSubmit(e as any)
    }
  }

  // Extract tool calls from message parts (AI SDK 4.2+)
  const extractToolCalls = (message: Message) => {
    if (!message.parts) return []

    return message.parts
      .filter((part: any) => part.type === "tool-invocation")
      .map((part: any) => ({
        toolName: part.toolInvocation?.toolName || "unknown",
        state: part.toolInvocation?.state as ToolCallState,
        args: part.toolInvocation?.args,
        result: part.toolInvocation?.result,
        error: part.toolInvocation?.error,
      }))
  }

  const displayError = localError || chatError?.message

  if (!featureSessionId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        Select a feature session to start chatting
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 bg-card border-b border-border flex items-center justify-between">
        <span className="font-medium">
          {featureSessionName || "Feature Chat"}
        </span>
        {isLoading && (
          <span className="text-sm text-blue-400 animate-pulse">
            ● Processing...
          </span>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {displayError && (
          <div className="p-3 bg-red-400/10 border border-red-400/30 rounded-md text-red-400 text-sm">
            {displayError}
          </div>
        )}

        {messages.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            <p className="mb-2">Start a conversation about this feature.</p>
            <p className="text-sm">
              Try: "Use platform-feature-discovery to analyze this feature"
            </p>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} className="space-y-2">
              {/* Message content */}
              <div
                className={cn(
                  "p-3 rounded-lg",
                  message.role === "user"
                    ? "bg-primary/20 ml-8"
                    : "bg-card mr-8"
                )}
              >
                <div
                  className={cn(
                    "text-xs font-medium mb-1",
                    message.role === "user" ? "text-primary" : "text-green-400"
                  )}
                >
                  {message.role === "user" ? "You" : "Assistant"}
                </div>
                <div className="text-sm whitespace-pre-wrap">
                  {message.content}
                </div>
              </div>

              {/* Tool calls */}
              {extractToolCalls(message).map((toolCall, index) => (
                <ToolCallPart
                  key={`${message.id}-tool-${index}`}
                  toolName={toolCall.toolName}
                  state={toolCall.state}
                  args={toolCall.args}
                  result={toolCall.result}
                  error={toolCall.error}
                />
              ))}
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={handleFormSubmit}
        className="p-4 border-t border-border bg-card"
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your message... (Shift+Enter for new line)"
          className="w-full p-3 bg-background border border-border rounded-md text-sm resize-none min-h-[80px] focus:outline-none focus:ring-2 focus:ring-primary"
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={!input.trim() || isLoading}
          className={cn(
            "mt-2 w-full py-2 px-4 bg-primary text-primary-foreground rounded-md font-medium text-sm transition-colors",
            (!input.trim() || isLoading) && "opacity-50 cursor-not-allowed"
          )}
        >
          {isLoading ? "Processing..." : "Send Message"}
        </button>
      </form>
    </div>
  )
})
