/**
 * AI Chat App
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { observer } from 'mobx-react-lite'
import { useStores } from './stores'
import { AuthGate } from './components/AuthGate'

interface MessageType {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
}

interface ChatType {
  id: string
  title: string
  visibility: string
  createdAt: string
  updatedAt: string
  messages?: MessageType[]
}

export default function App() {
  return (
    <AuthGate>
      <ChatApp />
    </AuthGate>
  )
}

const ChatApp = observer(function ChatApp() {
  const { auth } = useStores()
  const [chats, setChats] = useState<ChatType[]>([])
  const [selectedChat, setSelectedChat] = useState<ChatType | null>(null)
  const [messages, setMessages] = useState<MessageType[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const fetchChats = useCallback(async () => {
    if (!auth.user) return
    try {
      const res = await fetch(`/api/chats?userId=${auth.user.id}`)
      if (res.ok) {
        const data = await res.json()
        setChats(data.items || [])
      }
    } catch (err) {
      console.error('Failed to fetch chats:', err)
    } finally {
      setLoading(false)
    }
  }, [auth.user])

  const fetchMessages = useCallback(async (chatId: string) => {
    try {
      const res = await fetch(`/api/messages?chatId=${chatId}`)
      if (res.ok) {
        const data = await res.json()
        setMessages(data.items || [])
      }
    } catch (err) {
      console.error('Failed to fetch messages:', err)
    }
  }, [])

  useEffect(() => { fetchChats() }, [fetchChats])

  useEffect(() => {
    if (selectedChat) {
      fetchMessages(selectedChat.id)
    }
  }, [selectedChat, fetchMessages])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleNewChat = async () => {
    if (!auth.user) return
    try {
      const res = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: auth.user.id, title: 'New Chat' }),
      })
      if (res.ok) {
        const chat = await res.json()
        setChats([chat, ...chats])
        setSelectedChat(chat)
        setMessages([])
      }
    } catch (err) {
      console.error('Failed to create chat:', err)
    }
  }

  const handleDeleteChat = async (chatId: string) => {
    await fetch(`/api/chats/${chatId}`, { method: 'DELETE' })
    setChats(chats.filter(c => c.id !== chatId))
    if (selectedChat?.id === chatId) {
      setSelectedChat(null)
      setMessages([])
    }
  }

  const handleSend = async () => {
    if (!input.trim() || !selectedChat || sending) return

    const userMessage: MessageType = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: input,
      createdAt: new Date().toISOString(),
    }

    setMessages([...messages, userMessage])
    setInput('')
    setSending(true)

    try {
      // Save user message
      await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: selectedChat.id,
          role: 'user',
          content: input,
        }),
      })

      // Get AI response (simulated - in real app, this would call an AI API)
      const assistantMessage: MessageType = {
        id: `temp-ai-${Date.now()}`,
        role: 'assistant',
        content: getSimulatedResponse(input),
        createdAt: new Date().toISOString(),
      }

      // Save assistant message
      await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: selectedChat.id,
          role: 'assistant',
          content: assistantMessage.content,
        }),
      })

      setMessages(msgs => [...msgs, assistantMessage])

      // Update chat title if it's the first message
      if (messages.length === 0) {
        const title = input.slice(0, 30) + (input.length > 30 ? '...' : '')
        await fetch(`/api/chats/${selectedChat.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        })
        setChats(chats.map(c => c.id === selectedChat.id ? { ...c, title } : c))
      }
    } catch (err) {
      console.error('Failed to send message:', err)
    } finally {
      setSending(false)
    }
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-gray-900"><p className="text-gray-400">Loading...</p></div>
  }

  return (
    <div className="min-h-screen flex bg-gray-900">
      {/* Sidebar */}
      <div className="w-64 bg-gray-800 border-r border-gray-700 flex flex-col">
        <div className="p-4">
          <button onClick={handleNewChat} className="w-full px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">
            + New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {chats.map(chat => (
            <div
              key={chat.id}
              onClick={() => setSelectedChat(chat)}
              className={`p-3 mx-2 mb-1 rounded-lg cursor-pointer transition-colors ${
                selectedChat?.id === chat.id ? 'bg-gray-700' : 'hover:bg-gray-700'
              }`}
            >
              <div className="flex justify-between items-start">
                <span className="text-sm text-gray-300 truncate flex-1">{chat.title}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDeleteChat(chat.id) }}
                  className="text-gray-500 hover:text-red-500 text-xs ml-2"
                >×</button>
              </div>
            </div>
          ))}
        </div>
        <div className="p-4 border-t border-gray-700">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-400 truncate">{auth.user?.email}</span>
            <button onClick={() => auth.signOut()} className="text-xs text-gray-500 hover:text-gray-300">Sign Out</button>
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {selectedChat ? (
          <>
            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4">
              <div className="max-w-3xl mx-auto space-y-4">
                {messages.length === 0 && (
                  <div className="text-center py-12">
                    <p className="text-gray-500">Start a conversation...</p>
                  </div>
                )}
                {messages.map(msg => (
                  <div
                    key={msg.id}
                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[80%] p-4 rounded-2xl ${
                        msg.role === 'user'
                          ? 'bg-green-600 text-white'
                          : 'bg-gray-800 text-gray-300'
                      }`}
                    >
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                    </div>
                  </div>
                ))}
                {sending && (
                  <div className="flex justify-start">
                    <div className="bg-gray-800 text-gray-400 p-4 rounded-2xl">
                      <span className="animate-pulse">Thinking...</span>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* Input */}
            <div className="p-4 border-t border-gray-700">
              <div className="max-w-3xl mx-auto">
                <div className="flex gap-2">
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        handleSend()
                      }
                    }}
                    placeholder="Type a message..."
                    rows={1}
                    className="flex-1 px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 resize-none"
                    disabled={sending}
                  />
                  <button
                    onClick={handleSend}
                    disabled={!input.trim() || sending}
                    className="px-6 py-3 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 disabled:opacity-50"
                  >
                    Send
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <h2 className="text-2xl font-bold text-white mb-2">🤖 AI Chat</h2>
              <p className="text-gray-500 mb-4">Select a chat or create a new one to get started.</p>
              <button onClick={handleNewChat} className="px-6 py-3 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700">
                Start New Chat
              </button>
              <p className="text-xs text-gray-600 mt-6">Built with @shogo-ai/sdk + Hono</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
})

// Simulated AI responses for demo purposes
function getSimulatedResponse(input: string): string {
  const lowerInput = input.toLowerCase()

  if (lowerInput.includes('hello') || lowerInput.includes('hi')) {
    return "Hello! I'm an AI assistant built with @shogo-ai/sdk. How can I help you today?"
  }

  if (lowerInput.includes('help')) {
    return "I'm here to help! You can ask me questions, have a conversation, or just chat. This is a demo app showcasing the @shogo-ai/sdk capabilities."
  }

  if (lowerInput.includes('what can you do')) {
    return "I'm a demo AI chat application. In a production environment, I would be connected to an AI model like GPT-4 or Claude. For now, I can demonstrate the chat interface and data persistence features."
  }

  if (lowerInput.includes('thanks') || lowerInput.includes('thank you')) {
    return "You're welcome! Let me know if you need anything else."
  }

  // Default response
  const responses = [
    "That's an interesting point! In a full implementation, I would provide a more contextual response.",
    "I understand. This demo shows how chat messages are persisted using the @shogo-ai/sdk.",
    "Great question! The SDK handles all the data storage and API routes automatically.",
    "This chat interface demonstrates real-time message handling with MobX and Hono.",
  ]

  return responses[Math.floor(Math.random() * responses.length)]
}
