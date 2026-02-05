import { useChat } from '@ai-sdk/react'
import { useState, useEffect, useRef, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { Toaster, toast } from 'sonner'
import ReactMarkdown from 'react-markdown'
import {
  MessageSquare,
  Plus,
  Send,
  Square,
  Menu,
  X,
  Trash2,
  ChevronDown,
  User,
  Bot,
  LogOut,
} from 'lucide-react'
import { cn, generateUUID } from '@/lib/utils'
import { getAuthStore } from './generated/auth'

// Create a React hook for the auth store
function useAuthStore() {
  return getAuthStore()
}

// Types
interface Chat {
  id: string
  title: string
  userId: string
  createdAt: string
  updatedAt: string
}

// Sidebar Component
function Sidebar({
  isOpen,
  onClose,
  chats,
  currentChatId,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  user,
  onSignOut,
}: {
  isOpen: boolean
  onClose: () => void
  chats: Chat[]
  currentChatId: string | null
  onSelectChat: (id: string) => void
  onNewChat: () => void
  onDeleteChat: (id: string) => void
  user: { id: string; email: string } | null
  onSignOut: () => void
}) {
  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed left-0 top-0 z-50 flex h-full w-72 flex-col bg-sidebar border-r border-sidebar-border transition-transform duration-200 md:relative md:translate-x-0',
          isOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-sidebar-border">
          <h1 className="font-semibold text-lg text-sidebar-foreground">AI Chat</h1>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-sidebar-accent md:hidden"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* New Chat Button */}
        <div className="p-3">
          <button
            onClick={onNewChat}
            className="flex w-full items-center gap-2 rounded-lg border border-sidebar-border p-3 text-sm hover:bg-sidebar-accent transition-colors"
            data-testid="new-chat-button"
          >
            <Plus className="size-4" />
            New Chat
          </button>
        </div>

        {/* Chat List */}
        <div className="flex-1 overflow-y-auto p-2" data-testid="chat-history">
          {chats.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">No chats yet</p>
          ) : (
            <div className="space-y-1">
              {chats.map((chat) => (
                <div
                  key={chat.id}
                  className={cn(
                    'group flex items-center gap-2 rounded-lg px-3 py-2 text-sm cursor-pointer transition-colors',
                    currentChatId === chat.id
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'hover:bg-sidebar-accent/50'
                  )}
                  onClick={() => onSelectChat(chat.id)}
                >
                  <MessageSquare className="size-4 shrink-0" />
                  <span className="flex-1 truncate">{chat.title}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteChat(chat.id)
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 transition-opacity"
                  >
                    <Trash2 className="size-3.5 text-destructive" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* User section */}
        {user && (
          <div className="border-t border-sidebar-border p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <div className="size-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-sm font-medium shrink-0">
                  {user.email[0].toUpperCase()}
                </div>
                <span className="text-sm truncate text-sidebar-foreground">
                  {user.email}
                </span>
              </div>
              <button
                onClick={onSignOut}
                className="p-1.5 rounded-md hover:bg-sidebar-accent"
                title="Sign out"
              >
                <LogOut className="size-4" />
              </button>
            </div>
          </div>
        )}
      </aside>
    </>
  )
}

// Message Component
function Message({ role, content }: { role: string; content: string }) {
  const isUser = role === 'user'

  return (
    <div
      className={cn(
        'flex gap-3 px-4 py-6',
        isUser ? 'bg-background' : 'bg-muted/30'
      )}
      data-testid={`message-${role}`}
    >
      <div
        className={cn(
          'size-8 rounded-full flex items-center justify-center shrink-0',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-accent'
        )}
      >
        {isUser ? <User className="size-4" /> : <Bot className="size-4" />}
      </div>
      <div className="flex-1 min-w-0 prose prose-sm dark:prose-invert max-w-none">
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    </div>
  )
}

// Chat Header
function ChatHeader({
  onMenuClick,
  title,
}: {
  onMenuClick: () => void
  title: string
}) {
  return (
    <header className="flex items-center gap-3 border-b border-border px-4 py-3 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <button
        onClick={onMenuClick}
        className="p-2 rounded-md hover:bg-accent md:hidden"
        data-testid="menu-button"
      >
        <Menu className="size-5" />
      </button>
      <h2 className="font-medium truncate">{title}</h2>
    </header>
  )
}

// Suggested Actions
function SuggestedActions({ onSelect }: { onSelect: (text: string) => void }) {
  const suggestions = [
    'What is the weather in San Francisco?',
    'Help me write a poem about nature',
    'Explain quantum computing simply',
    'What are some healthy breakfast ideas?',
  ]

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" data-testid="suggested-actions">
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          onClick={() => onSelect(suggestion)}
          className="text-left px-4 py-3 rounded-xl border border-border hover:bg-accent transition-colors text-sm"
        >
          {suggestion}
        </button>
      ))}
    </div>
  )
}

// Chat Input
function ChatInput({
  input,
  setInput,
  onSubmit,
  onStop,
  isLoading,
  disabled,
}: {
  input: string
  setInput: (value: string) => void
  onSubmit: () => void
  onStop: () => void
  isLoading: boolean
  disabled: boolean
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!disabled && input.trim()) {
        onSubmit()
      }
    }
  }

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`
    }
  }, [input])

  return (
    <div className="border border-border rounded-xl bg-background shadow-sm">
      <textarea
        ref={textareaRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Send a message..."
        rows={1}
        className="w-full resize-none bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
        data-testid="chat-input"
        disabled={disabled}
      />
      <div className="flex items-center justify-end px-3 pb-3">
        {isLoading ? (
          <button
            onClick={onStop}
            className="size-8 rounded-full bg-foreground text-background flex items-center justify-center hover:bg-foreground/90 transition-colors"
            data-testid="stop-button"
          >
            <Square className="size-3.5" fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={onSubmit}
            disabled={disabled || !input.trim()}
            className="size-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 transition-colors disabled:bg-muted disabled:text-muted-foreground"
            data-testid="send-button"
          >
            <Send className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

// Login Page Component
function LoginPage({ onLogin }: { onLogin: (user: { id: string; email: string }) => void }) {
  const auth = useAuthStore()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isSignUp, setIsSignUp] = useState(false)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)

    try {
      if (isSignUp) {
        const user = await auth.signUp({ email, password })
        onLogin({ id: user.id, email: user.email })
      } else {
        const user = await auth.signIn({ email, password })
        onLogin({ id: user.id, email: user.email })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An error occurred'
      setError(message)
      // If sign in fails with "not found", suggest sign up
      if (message.includes('not found') || message.includes('No account')) {
        setIsSignUp(true)
      }
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">AI Chat</h1>
          <p className="text-muted-foreground">
            {isSignUp ? 'Create an account to get started' : 'Sign in to continue'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium mb-1.5">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder="you@example.com"
              required
              data-testid="email-input"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium mb-1.5">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder="••••••••"
              required
              minLength={6}
              data-testid="password-input"
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            data-testid="submit-button"
          >
            {isLoading ? 'Loading...' : isSignUp ? 'Sign Up' : 'Sign In'}
          </button>
        </form>

        <div className="text-center">
          <button
            onClick={() => setIsSignUp(!isSignUp)}
            className="text-sm text-muted-foreground hover:text-foreground"
            data-testid="toggle-auth-mode"
          >
            {isSignUp ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
          </button>
        </div>
      </div>
    </div>
  )
}

// Main Chat App Component
function ChatApp({ user, onSignOut }: { user: { id: string; email: string }; onSignOut: () => void }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [chats, setChats] = useState<Chat[]>([])
  const [currentChatId, setCurrentChatId] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Use the AI SDK's useChat hook
  const {
    messages,
    input,
    setInput,
    append,
    isLoading,
    stop,
    setMessages,
  } = useChat({
    api: '/api/chat',
    id: currentChatId || undefined,
    body: {
      userId: user.id,
    },
    onFinish: () => {
      // Refresh chat list to get updated titles
      fetchChats()
    },
    onError: (error) => {
      toast.error('Failed to send message')
      console.error('Chat error:', error)
    },
  })

  // Fetch user's chats
  const fetchChats = useCallback(async () => {
    try {
      const response = await fetch(`/api/chats?userId=${user.id}`)
      if (response.ok) {
        const data = await response.json()
        // Sort by updatedAt descending
        const sortedChats = (data.items || data || []).sort(
          (a: Chat, b: Chat) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        )
        setChats(sortedChats)
      }
    } catch (error) {
      console.error('Failed to fetch chats:', error)
    }
  }, [user.id])

  // Fetch messages for current chat
  const fetchMessages = useCallback(async (chatId: string) => {
    try {
      const response = await fetch(`/api/messages?chatId=${chatId}`)
      if (response.ok) {
        const data = await response.json()
        const msgs = (data.items || data || []).sort(
          (a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        )
        // Convert to useChat format
        const formattedMessages = msgs.map((m: any) => {
          const parts = JSON.parse(m.parts || '[]')
          const textPart = parts.find((p: any) => p.type === 'text')
          return {
            id: m.id,
            role: m.role,
            content: textPart?.text || '',
          }
        })
        setMessages(formattedMessages)
      }
    } catch (error) {
      console.error('Failed to fetch messages:', error)
    }
  }, [setMessages])

  // Initial load
  useEffect(() => {
    fetchChats()
  }, [fetchChats])

  // Load messages when chat changes
  useEffect(() => {
    if (currentChatId) {
      fetchMessages(currentChatId)
    } else {
      setMessages([])
    }
  }, [currentChatId, fetchMessages, setMessages])

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Create new chat
  const handleNewChat = async () => {
    const id = generateUUID()
    try {
      const response = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          title: 'New Chat',
          userId: user.id,
        }),
      })
      if (response.ok) {
        setCurrentChatId(id)
        setMessages([])
        fetchChats()
        setSidebarOpen(false)
      }
    } catch (error) {
      toast.error('Failed to create chat')
    }
  }

  // Select chat
  const handleSelectChat = (id: string) => {
    setCurrentChatId(id)
    setSidebarOpen(false)
  }

  // Delete chat
  const handleDeleteChat = async (id: string) => {
    try {
      await fetch(`/api/chats/${id}`, { method: 'DELETE' })
      if (currentChatId === id) {
        setCurrentChatId(null)
        setMessages([])
      }
      fetchChats()
    } catch (error) {
      toast.error('Failed to delete chat')
    }
  }

  // Send message
  const handleSend = async () => {
    if (!input.trim()) return

    // Create chat if needed
    let chatId = currentChatId
    if (!chatId) {
      chatId = generateUUID()
      try {
        await fetch('/api/chats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: chatId,
            title: 'New Chat',
            userId: user.id,
          }),
        })
        setCurrentChatId(chatId)
      } catch (error) {
        toast.error('Failed to create chat')
        return
      }
    }

    // Send message using AI SDK
    append({
      role: 'user',
      content: input,
    }, {
      body: {
        id: chatId,
        userId: user.id,
        message: {
          id: generateUUID(),
          parts: [{ type: 'text', text: input }],
        },
      },
    })
  }

  // Handle suggested action
  const handleSuggestedAction = (text: string) => {
    setInput(text)
  }

  const currentChat = chats.find((c) => c.id === currentChatId)

  return (
    <div className="flex h-screen bg-background">
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        chats={chats}
        currentChatId={currentChatId}
        onSelectChat={handleSelectChat}
        onNewChat={handleNewChat}
        onDeleteChat={handleDeleteChat}
        user={user}
        onSignOut={onSignOut}
      />

      <main className="flex flex-1 flex-col min-w-0">
        <ChatHeader
          onMenuClick={() => setSidebarOpen(true)}
          title={currentChat?.title || 'New Chat'}
        />

        <div className="flex-1 overflow-y-auto" data-testid="messages-container">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full p-8">
              <div className="max-w-lg w-full space-y-8">
                <div className="text-center space-y-2">
                  <h2 className="text-2xl font-semibold">How can I help you today?</h2>
                  <p className="text-muted-foreground">
                    Start a conversation or try one of these suggestions
                  </p>
                </div>
                <SuggestedActions onSelect={handleSuggestedAction} />
              </div>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {messages.map((message) => (
                <Message
                  key={message.id}
                  role={message.role}
                  content={message.content}
                />
              ))}
              {isLoading && (
                <div className="flex gap-3 px-4 py-6 bg-muted/30" data-testid="thinking-indicator">
                  <div className="size-8 rounded-full bg-accent flex items-center justify-center">
                    <Bot className="size-4" />
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="animate-pulse">Thinking</span>
                    <span className="animate-bounce" style={{ animationDelay: '0ms' }}>.</span>
                    <span className="animate-bounce" style={{ animationDelay: '150ms' }}>.</span>
                    <span className="animate-bounce" style={{ animationDelay: '300ms' }}>.</span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        <div className="border-t border-border p-4 bg-background">
          <div className="max-w-4xl mx-auto">
            <ChatInput
              input={input}
              setInput={setInput}
              onSubmit={handleSend}
              onStop={stop}
              isLoading={isLoading}
              disabled={false}
            />
          </div>
        </div>
      </main>
    </div>
  )
}

// Root App Component
export const App = observer(function App() {
  const [user, setUser] = useState<{ id: string; email: string } | null>(null)
  const auth = useAuthStore()

  // Check for existing session on mount (from localStorage)
  useEffect(() => {
    // The auth store automatically loads from localStorage in constructor
    if (auth.user) {
      setUser({ id: auth.user.id, email: auth.user.email })
    }
  }, [auth])

  const handleSignOut = async () => {
    await auth.signOut()
    setUser(null)
  }

  if (!user) {
    return <LoginPage onLogin={setUser} />
  }

  return (
    <>
      <Toaster position="top-center" />
      <ChatApp user={user} onSignOut={handleSignOut} />
    </>
  )
})
