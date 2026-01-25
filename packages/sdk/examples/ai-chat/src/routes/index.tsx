/**
 * AI Chat - Main Page
 * 
 * Adapted from Vercel AI Chatbot for TanStack Start + @shogo-ai/sdk
 */

import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState, useRef, useEffect } from 'react'
import { loginUser, type UserType } from '../utils/user'
import { getChats, createChat, deleteChat, type ChatType } from '../utils/chats'
import { getMessages, saveMessage, type MessageType } from '../utils/messages'
import { generateAIResponse, type AIMessage } from '../utils/ai'

export const Route = createFileRoute('/')({
  loader: async ({ context }) => {
    if (!context.user) {
      return { chats: [] as ChatType[] }
    }
    try {
      const chats = await getChats({ data: { userId: context.user.id } })
      return { chats: chats || [] }
    } catch (err) {
      console.error('Failed to load chats:', err)
      return { chats: [] as ChatType[] }
    }
  },
  component: AIChat,
})

function AIChat() {
  const { user } = Route.useRouteContext()
  const loaderData = Route.useLoaderData()
  const router = useRouter()
  
  // Ensure chats is always an array
  const initialChats = Array.isArray(loaderData?.chats) ? loaderData.chats : []

  if (!user) {
    return <AuthPage onComplete={() => router.invalidate()} />
  }

  return <ChatApp user={user} initialChats={initialChats} />
}

function AuthPage({ onComplete }: { onComplete: () => void }) {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email) return

    setLoading(true)
    setError('')

    try {
      await loginUser({ data: { email } })
      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sign in')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">Welcome to AI Chat</h1>
        <p className="auth-subtitle">Enter your email to get started with your personal AI assistant.</p>
        
        <form onSubmit={handleSubmit} className="auth-form">
          <input
            type="email"
            placeholder="Enter your email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="auth-input"
            autoFocus
          />
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" disabled={loading} className="auth-btn">
            {loading ? 'Signing in...' : 'Continue'}
          </button>
        </form>

        <p className="auth-footer">
          Built with @shogo-ai/sdk + Vercel AI SDK
        </p>
      </div>
    </div>
  )
}

// SVG Icons
const Icons = {
  sidebar: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </svg>
  ),
  plus: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  sparkles: () => (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
    </svg>
  ),
  send: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  ),
  copy: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  ),
  trash: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  ),
  paperclip: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  ),
  check: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  ),
}

function ChatApp({ user, initialChats }: { user: UserType; initialChats: ChatType[] }) {
  const router = useRouter()
  // Ensure initialChats is always an array to prevent map errors
  const [chats, setChats] = useState(Array.isArray(initialChats) ? initialChats : [])
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageType[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Load messages when active chat changes
  useEffect(() => {
    if (activeChatId) {
      loadMessages(activeChatId)
    } else {
      setMessages([])
    }
  }, [activeChatId])

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Auto-resize textarea
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 200) + 'px'
    }
  }, [input])

  const loadMessages = async (chatId: string) => {
    try {
      const msgs = await getMessages({ data: { chatId, userId: user.id } })
      setMessages(msgs)
    } catch (err) {
      console.error('Failed to load messages:', err)
    }
  }

  const handleNewChat = async () => {
    setActiveChatId(null)
    setMessages([])
    inputRef.current?.focus()
  }

  const handleDeleteChat = async (chatId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await deleteChat({ data: { chatId, userId: user.id } })
      setChats(chats.filter(c => c.id !== chatId))
      if (activeChatId === chatId) {
        setActiveChatId(null)
        setMessages([])
      }
    } catch (err) {
      console.error('Failed to delete chat:', err)
    }
  }

  const handleSend = async (messageText?: string) => {
    const text = messageText || input.trim()
    if (!text || isLoading) return

    let chatId = activeChatId

    // Create new chat if needed
    if (!chatId) {
      try {
        const chat = await createChat({ data: { userId: user.id } })
        setChats([chat, ...chats])
        chatId = chat.id
        setActiveChatId(chatId)
      } catch (err) {
        console.error('Failed to create chat:', err)
        return
      }
    }

    setInput('')
    setIsLoading(true)

    // Add user message to UI immediately
    const tempUserMsg: MessageType = {
      id: 'temp-user-' + Date.now(),
      role: 'user',
      content: text,
      chatId: chatId,
      createdAt: new Date(),
    }
    setMessages(prev => [...prev, tempUserMsg])

    try {
      // Save user message
      const savedUserMsg = await saveMessage({
        data: {
          chatId: chatId,
          userId: user.id,
          role: 'user',
          content: text,
        },
      })

      // Update with saved version
      setMessages(prev => prev.map(m => 
        m.id === tempUserMsg.id ? savedUserMsg : m
      ))

      // Update chat title if first message
      if (messages.length === 0) {
        const title = text.slice(0, 50) + (text.length > 50 ? '...' : '')
        setChats(prev => prev.map(c => 
          c.id === chatId ? { ...c, title } : c
        ))
      }

      // Add loading indicator
      const tempAssistantId = 'temp-assistant-' + Date.now()
      setMessages(prev => [...prev, {
        id: tempAssistantId,
        role: 'assistant',
        content: '',
        chatId: chatId!,
        createdAt: new Date(),
      }])

      // Build message history
      const history: AIMessage[] = messages
        .filter(m => !m.id.startsWith('temp-'))
        .map(m => ({ 
          role: m.role as 'user' | 'assistant', 
          content: m.content 
        }))
      history.push({ role: 'user', content: text })

      // Generate AI response
      const response = await generateAIResponse({
        data: {
          messages: history,
          chatId: chatId,
          userId: user.id,
        },
      })

      // Save assistant message
      const savedAssistantMsg = await saveMessage({
        data: {
          chatId: chatId,
          userId: user.id,
          role: 'assistant',
          content: response.content,
        },
      })

      // Update with saved version
      setMessages(prev => prev.map(m => 
        m.id === tempAssistantId ? savedAssistantMsg : m
      ))

    } catch (err) {
      console.error('Failed to send message:', err)
      // Remove temp messages on error
      setMessages(prev => prev.filter(m => !m.id.startsWith('temp-')))
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleSuggestion = (text: string) => {
    handleSend(text)
  }

  const suggestions = [
    "What are the advantages of using React?",
    "Write a function to reverse a string",
    "Explain how async/await works in JavaScript",
    "What is the difference between SQL and NoSQL?",
  ]

  return (
    <div className="app">
      {/* Sidebar */}
      <aside className={`sidebar ${!sidebarOpen ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <button className="icon-btn" onClick={() => setSidebarOpen(false)}>
            <Icons.sidebar />
          </button>
          <button className="new-chat-btn" onClick={handleNewChat}>
            <Icons.plus />
            <span>New Chat</span>
          </button>
        </div>

        <div className="sidebar-section">Today</div>

        <div className="chat-list">
          {chats.length === 0 ? (
            <div style={{ padding: '12px', color: '#525252', fontSize: '0.875rem' }}>
              Your conversations will appear here once you start chatting!
            </div>
          ) : (
            chats.map(chat => (
              <div
                key={chat.id}
                className={`chat-item ${activeChatId === chat.id ? 'active' : ''}`}
                onClick={() => setActiveChatId(chat.id)}
              >
                <span className="chat-item-title">{chat.title}</span>
                <button
                  className="chat-item-delete"
                  onClick={(e) => handleDeleteChat(chat.id, e)}
                  aria-label="Delete chat"
                >
                  <Icons.trash />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="sidebar-footer">
          <button className="user-button">
            <div className="user-avatar">
              {user.email[0].toUpperCase()}
            </div>
            <div className="user-info">
              <div className="user-name">{user.email}</div>
              <div className="user-label">Free</div>
            </div>
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="main">
        {/* Header */}
        <header className="header">
          <div className="header-left">
            {!sidebarOpen && (
              <button className="icon-btn" onClick={() => setSidebarOpen(true)}>
                <Icons.sidebar />
              </button>
            )}
            <button className="icon-btn" onClick={handleNewChat}>
              <Icons.plus />
            </button>
          </div>
          <div className="header-right">
            {/* Placeholder for additional header items */}
          </div>
        </header>

        {/* Messages or Welcome */}
        <div className="messages-area">
          {!activeChatId && messages.length === 0 ? (
            <div className="welcome">
              <h1 className="welcome-title">Hello there!</h1>
              <p className="welcome-subtitle">How can I help you today?</p>
              
              <div className="suggestions">
                {suggestions.map((suggestion, i) => (
                  <button
                    key={i}
                    className="suggestion-btn"
                    onClick={() => handleSuggestion(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="messages-scroll">
              <div className="messages">
                {messages.map(message => (
                  <Message 
                    key={message.id} 
                    message={message} 
                    isLoading={isLoading && message.content === ''} 
                  />
                ))}
                <div ref={messagesEndRef} />
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="input-area">
          <div className="input-container">
            <div className="input-box">
              <div className="input-main">
                <textarea
                  ref={inputRef}
                  className="input-field"
                  placeholder="Send a message..."
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={1}
                  disabled={isLoading}
                />
              </div>
              <div className="input-footer">
                <div className="input-left">
                  <button className="attach-btn" title="Attach file">
                    <Icons.paperclip />
                  </button>
                  <button className="model-badge">
                    <Icons.sparkles />
                    <span>GPT-4o Mini</span>
                  </button>
                </div>
                <button
                  className="send-btn"
                  onClick={() => handleSend()}
                  disabled={!input.trim() || isLoading}
                >
                  <Icons.send />
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}

function Message({ message, isLoading }: { message: MessageType; isLoading?: boolean }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (message.role === 'user') {
    return (
      <div className="message" data-role="user">
        <div className="message-bubble">
          <span className="message-text">{message.content}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="message" data-role="assistant">
      <div className="message-icon">
        <Icons.sparkles />
      </div>
      <div className="message-content">
        {isLoading ? (
          <div className="thinking">
            <span className="thinking-text">Thinking</span>
            <span className="thinking-dots">
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </span>
          </div>
        ) : (
          <>
            <div className="message-text">
              <MessageContent content={message.content} />
            </div>
            <div className="message-actions">
              <button className="action-btn" onClick={handleCopy}>
                {copied ? <Icons.check /> : <Icons.copy />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function MessageContent({ content }: { content: string }) {
  // Handle code blocks - guard against undefined content
  if (!content) {
    return null
  }
  const parts = content.split(/(```[\s\S]*?```)/g)
  
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('```')) {
          const match = part.match(/```(\w+)?\n?([\s\S]*?)```/)
          if (match) {
            const [, , code] = match
            return (
              <pre key={i}>
                <code>{code.trim()}</code>
              </pre>
            )
          }
        }
        
        // Handle inline code
        const inlineParts = part.split(/(`[^`]+`)/g)
        return (
          <span key={i}>
            {inlineParts.map((inline, j) => {
              if (inline.startsWith('`') && inline.endsWith('`')) {
                return <code key={j}>{inline.slice(1, -1)}</code>
              }
              
              // Handle bold
              const boldParts = inline.split(/(\*\*[^*]+\*\*)/g)
              return boldParts.map((bold, k) => {
                if (bold.startsWith('**') && bold.endsWith('**')) {
                  return <strong key={k}>{bold.slice(2, -2)}</strong>
                }
                return bold
              })
            })}
          </span>
        )
      })}
    </>
  )
}
