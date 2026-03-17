import { useState, useRef, useEffect } from 'react'
import {
  useAgentStatus,
  useAgentChat,
  useCanvasStream,
  type Surface,
} from '@shogo-ai/sdk/agent'

interface ReviewItem {
  id: string
  title: string
  description: string
  category?: string
  createdAt: string
  status: 'pending' | 'approved' | 'rejected'
  metadata?: Record<string, unknown>
}

function useReviewItems() {
  const { surfaces, dispatchAction } = useCanvasStream()
  const [items, setItems] = useState<ReviewItem[]>([])

  useEffect(() => {
    for (const surface of surfaces.values()) {
      const data = surface.data
      const reviewData = data['/reviews'] || data['/items'] || data['/queue']
      if (Array.isArray(reviewData)) {
        setItems(reviewData as ReviewItem[])
      }
    }
  }, [surfaces])

  const approve = async (item: ReviewItem) => {
    const surfaceId = surfaces.keys().next().value
    if (!surfaceId) return
    await dispatchAction(surfaceId, 'approve', {
      id: item.id,
      _sendToAgent: true,
    })
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, status: 'approved' } : i)))
  }

  const reject = async (item: ReviewItem) => {
    const surfaceId = surfaces.keys().next().value
    if (!surfaceId) return
    await dispatchAction(surfaceId, 'reject', {
      id: item.id,
      _sendToAgent: true,
    })
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, status: 'rejected' } : i)))
  }

  return { items, approve, reject }
}

function StatusBar() {
  const { status } = useAgentStatus({ pollInterval: 5000 })

  return (
    <div className="flex items-center gap-3 text-sm">
      <span className={`w-2 h-2 rounded-full ${status?.status === 'running' ? 'bg-green-500' : 'bg-yellow-500'}`} />
      <span className="text-muted-foreground">Agent: {status?.status ?? 'connecting...'}</span>
      {status?.model && <span className="text-muted-foreground">· {status.model.name}</span>}
    </div>
  )
}

function ReviewQueue() {
  const { items, approve, reject } = useReviewItems()
  const pending = items.filter((i) => i.status === 'pending')
  const decided = items.filter((i) => i.status !== 'pending')

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold mb-3">
          Pending Review <span className="text-muted-foreground font-normal">({pending.length})</span>
        </h2>
        {pending.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
            <p className="text-lg mb-1">No items pending review</p>
            <p className="text-sm">Your agent will push items here when it has work for you to approve.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {pending.map((item) => (
              <div key={item.id} className="rounded-lg border p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-medium">{item.title}</h3>
                    {item.category && (
                      <span className="text-xs bg-muted px-2 py-0.5 rounded-full">{item.category}</span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{item.description}</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => approve(item)}
                    className="px-4 py-1.5 rounded-md text-sm font-medium bg-green-600 text-white hover:bg-green-700"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => reject(item)}
                    className="px-4 py-1.5 rounded-md text-sm font-medium bg-red-600 text-white hover:bg-red-700"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {decided.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">
            History <span className="text-muted-foreground font-normal">({decided.length})</span>
          </h2>
          <div className="space-y-2">
            {decided.map((item) => (
              <div key={item.id} className="rounded-lg border p-3 flex items-center justify-between opacity-75">
                <div>
                  <span className="font-medium text-sm">{item.title}</span>
                  {item.category && (
                    <span className="text-xs bg-muted px-2 py-0.5 rounded-full ml-2">{item.category}</span>
                  )}
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  item.status === 'approved' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                }`}>
                  {item.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ChatSidebar() {
  const { messages, send, isStreaming } = useAgentChat()
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = () => {
    if (!input.trim() || isStreaming) return
    send(input.trim())
    setInput('')
  }

  return (
    <div className="rounded-lg border flex flex-col h-full">
      <div className="px-4 py-3 border-b">
        <h2 className="font-semibold">Discuss with Agent</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
        {messages.length === 0 && (
          <p className="text-xs text-muted-foreground text-center mt-4">Ask questions about review items</p>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`text-sm ${msg.role === 'user' ? 'text-right' : ''}`}>
            <div className={`inline-block max-w-[90%] rounded-lg px-3 py-1.5 ${
              msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'
            }`}>
              {msg.content}
            </div>
          </div>
        ))}
        {isStreaming && <div className="text-xs text-muted-foreground animate-pulse">Thinking...</div>}
        <div ref={bottomRef} />
      </div>
      <div className="p-2 border-t flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Ask about an item..."
          className="flex-1 rounded-md border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          disabled={isStreaming}
        />
        <button
          onClick={handleSend}
          disabled={isStreaming || !input.trim()}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Approval Workflow</h1>
          <p className="text-sm text-muted-foreground">Review and approve your agent's work output</p>
        </div>
        <StatusBar />
      </header>
      <main className="max-w-7xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <ReviewQueue />
        </div>
        <div className="lg:col-span-1 h-[600px]">
          <ChatSidebar />
        </div>
      </main>
    </div>
  )
}
