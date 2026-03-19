import { useState, useRef, useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import {
  useAgentStatus,
  useAgentChat,
  useCanvasStream,
  type Surface,
} from '@shogo-ai/sdk/agent'
import { useStores } from './stores'
import { AuthGate } from './components/AuthGate'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { LogOut, Send, Check, X, Clock, CheckCircle, XCircle } from 'lucide-react'

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
          <Card>
            <CardContent className="py-8 text-center">
              <Clock className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
              <p className="text-muted-foreground">No items pending review</p>
              <p className="text-sm text-muted-foreground mt-1">Your agent will push items here when it has work for you to approve.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {pending.map((item) => (
              <Card key={item.id}>
                <CardContent className="py-4 space-y-3">
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
                    <Button size="sm" onClick={() => approve(item)} className="bg-green-600 hover:bg-green-700">
                      <Check className="h-4 w-4" />
                      Approve
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => reject(item)}>
                      <X className="h-4 w-4" />
                      Reject
                    </Button>
                  </div>
                </CardContent>
              </Card>
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
              <Card key={item.id} className="opacity-75">
                <CardContent className="py-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {item.status === 'approved'
                      ? <CheckCircle className="h-4 w-4 text-green-600" />
                      : <XCircle className="h-4 w-4 text-destructive" />}
                    <span className="font-medium text-sm">{item.title}</span>
                    {item.category && (
                      <span className="text-xs bg-muted px-2 py-0.5 rounded-full">{item.category}</span>
                    )}
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    item.status === 'approved' ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
                  }`}>
                    {item.status}
                  </span>
                </CardContent>
              </Card>
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
    <Card className="flex flex-col h-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Discuss with Agent</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto space-y-2 min-h-0">
        {messages.length === 0 && (
          <p className="text-xs text-muted-foreground text-center mt-4">Ask questions about review items</p>
        )}
        {messages.map((msg: any, i: number) => (
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
      </CardContent>
      <div className="p-3 border-t flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Ask about an item..."
          disabled={isStreaming}
        />
        <Button onClick={handleSend} disabled={isStreaming || !input.trim()} size="icon">
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  )
}

const WorkflowContent = observer(function WorkflowContent() {
  const { auth } = useStores()

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Approval Workflow</h1>
            <CardDescription>Review and approve your agent's work output</CardDescription>
          </div>
          <div className="flex items-center gap-4">
            <StatusBar />
            <Button variant="ghost" size="sm" onClick={() => auth.signOut()}>
              <LogOut className="h-4 w-4" />
              Sign Out
            </Button>
          </div>
        </div>
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
})

export default function App() {
  return (
    <AuthGate>
      <WorkflowContent />
    </AuthGate>
  )
}
