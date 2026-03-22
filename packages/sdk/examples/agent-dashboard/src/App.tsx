import { useState, useRef, useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import {
  useAgentStatus,
  useAgentChat,
  useCanvasStream,
  useAgentFiles,
  useAgentMode,
  type Surface,
} from '@shogo-ai/sdk/agent'
import { useStores } from './stores'
import { AuthGate } from './components/AuthGate'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { LogOut, RefreshCw, Send, ChevronRight, ChevronDown, FileText } from 'lucide-react'

function StatusCard() {
  const { status, loading, error, refetch } = useAgentStatus({ pollInterval: 5000 })

  if (loading) return <Card className="animate-pulse"><CardContent className="py-6 text-muted-foreground">Loading status...</CardContent></Card>
  if (error) return <Card><CardContent className="py-6 text-destructive">Error: {error.message}</CardContent></Card>

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Agent Status</CardTitle>
          <Button variant="ghost" size="sm" onClick={refetch}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-muted-foreground">Status</span>
            <div className="font-medium flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${status?.status === 'running' ? 'bg-green-500' : 'bg-yellow-500'}`} />
              {status?.status ?? 'unknown'}
            </div>
          </div>
          <div>
            <span className="text-muted-foreground">Mode</span>
            <div className="font-medium">{status?.activeMode ?? 'none'}</div>
          </div>
          <div>
            <span className="text-muted-foreground">Model</span>
            <div className="font-medium">{status?.model?.name ?? 'N/A'}</div>
          </div>
          <div>
            <span className="text-muted-foreground">Heartbeat</span>
            <div className="font-medium">{status?.heartbeat?.enabled ? `Every ${status.heartbeat.interval}s` : 'Disabled'}</div>
          </div>
        </div>
        {status?.channels && status.channels.length > 0 && (
          <div className="mt-3">
            <span className="text-sm text-muted-foreground">Channels</span>
            <div className="flex gap-1.5 mt-1 flex-wrap">
              {status.channels.map((ch: any, i: number) => (
                <span key={i} className={`text-xs px-2 py-0.5 rounded-full ${ch.connected ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' : 'bg-muted text-muted-foreground'}`}>
                  {ch.type}
                </span>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ChatPanel() {
  const { messages, send, isStreaming, error } = useAgentChat()
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
    <Card className="flex flex-col h-[400px]">
      <CardHeader className="pb-3">
        <CardTitle>Chat</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto space-y-3 min-h-0">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground text-center mt-8">Send a message to talk to your agent</p>
        )}
        {messages.map((msg: any, i: number) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
              msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'
            }`}>
              {msg.content}
            </div>
          </div>
        ))}
        {isStreaming && <div className="text-sm text-muted-foreground animate-pulse">Agent is thinking...</div>}
        {error && <div className="text-sm text-destructive">{error.message}</div>}
        <div ref={bottomRef} />
      </CardContent>
      <div className="p-3 border-t flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Message your agent..."
          disabled={isStreaming}
        />
        <Button onClick={handleSend} disabled={isStreaming || !input.trim()} size="icon">
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  )
}

function CanvasViewer() {
  const { surfaces, connected } = useCanvasStream()

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Canvas Surfaces</CardTitle>
          <span className={`text-xs px-2 py-0.5 rounded-full ${connected ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' : 'bg-muted text-muted-foreground'}`}>
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {surfaces.size === 0 ? (
          <p className="text-sm text-muted-foreground">No canvas surfaces active. The agent will create surfaces when it has visual output to display.</p>
        ) : (
          <div className="space-y-2">
            {Array.from(surfaces.values()).map((surface: Surface) => (
              <div key={surface.id} className="rounded-lg border p-3">
                <div className="font-medium text-sm">{surface.title || surface.id}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {surface.components.length} components · {Object.keys(surface.data).length} data paths
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function FileBrowser() {
  const { tree, loading, error, readFile } = useAgentFiles()
  const [selectedContent, setSelectedContent] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  const handleFileClick = async (path: string) => {
    try {
      const content = await readFile(path)
      setSelectedContent(content)
      setSelectedPath(path)
    } catch {
      setSelectedContent('Failed to read file')
      setSelectedPath(path)
    }
  }

  if (loading) return <Card className="animate-pulse"><CardContent className="py-6 text-muted-foreground">Loading files...</CardContent></Card>

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace Files</CardTitle>
      </CardHeader>
      <CardContent>
        {error && <div className="text-sm text-destructive mb-3">{error.message}</div>}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1 max-h-[300px] overflow-y-auto">
            {tree && tree.length > 0 ? (
              tree.map((node: any, i: number) => (
                <FileTreeNode key={i} node={node} depth={0} onFileClick={handleFileClick} />
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No files in workspace</p>
            )}
          </div>
          {selectedContent !== null && (
            <div className="border rounded-lg p-3">
              <div className="text-xs font-medium text-muted-foreground mb-2">{selectedPath}</div>
              <pre className="text-xs overflow-auto max-h-[250px] whitespace-pre-wrap">{selectedContent}</pre>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function FileTreeNode({ node, depth, onFileClick }: { node: any; depth: number; onFileClick: (path: string) => void }) {
  const [expanded, setExpanded] = useState(depth === 0)

  if (node.type === 'directory') {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-sm hover:bg-muted px-2 py-0.5 rounded w-full text-left"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          {expanded ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
          <span>{node.name}/</span>
        </button>
        {expanded && node.children?.map((child: any, i: number) => (
          <FileTreeNode key={i} node={child} depth={depth + 1} onFileClick={onFileClick} />
        ))}
      </div>
    )
  }

  return (
    <button
      onClick={() => onFileClick(node.path)}
      className="flex items-center gap-1 text-sm hover:bg-muted px-2 py-0.5 rounded w-full text-left"
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      <FileText className="h-3 w-3 text-muted-foreground" />
      <span>{node.name}</span>
    </button>
  )
}

function ModeControl() {
  const { mode, loading, setMode } = useAgentMode()

  if (loading) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mode Control</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2">
          {(['none', 'canvas', 'app'] as const).map((m) => (
            <Button
              key={m}
              variant={mode === m ? 'default' : 'secondary'}
              size="sm"
              onClick={() => setMode(m)}
            >
              {m}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

const DashboardContent = observer(function DashboardContent() {
  const { auth } = useStores()

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Agent Dashboard</h1>
            <CardDescription>Monitor, chat with, and control your AI agent</CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => auth.signOut()}>
            <LogOut className="h-4 w-4" />
            Sign Out
          </Button>
        </div>
      </header>
      <main className="max-w-7xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <StatusCard />
          <ModeControl />
          <CanvasViewer />
        </div>
        <div className="space-y-6">
          <ChatPanel />
          <FileBrowser />
        </div>
      </main>
    </div>
  )
})

export default function App() {
  return (
    <AuthGate>
      <DashboardContent />
    </AuthGate>
  )
}
