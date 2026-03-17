import { useState, useRef, useEffect } from 'react'
import {
  useAgentStatus,
  useAgentChat,
  useCanvasStream,
  useAgentFiles,
  useAgentMode,
  type Surface,
} from '@shogo-ai/sdk/agent'

function StatusCard() {
  const { status, loading, error, refetch } = useAgentStatus({ pollInterval: 5000 })

  if (loading) return <div className="rounded-lg border p-4 animate-pulse bg-muted/50">Loading status...</div>
  if (error) return <div className="rounded-lg border p-4 text-destructive">Error: {error.message}</div>

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Agent Status</h2>
        <button onClick={refetch} className="text-sm text-muted-foreground hover:text-foreground">
          Refresh
        </button>
      </div>
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
        <div>
          <span className="text-sm text-muted-foreground">Channels</span>
          <div className="flex gap-1.5 mt-1 flex-wrap">
            {status.channels.map((ch, i) => (
              <span key={i} className={`text-xs px-2 py-0.5 rounded-full ${ch.connected ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                {ch.type}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
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
    <div className="rounded-lg border flex flex-col h-[400px]">
      <div className="px-4 py-3 border-b">
        <h2 className="text-lg font-semibold">Chat</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground text-center mt-8">Send a message to talk to your agent</p>
        )}
        {messages.map((msg, i) => (
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
      </div>
      <div className="p-3 border-t flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Message your agent..."
          className="flex-1 rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          disabled={isStreaming}
        />
        <button
          onClick={handleSend}
          disabled={isStreaming || !input.trim()}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  )
}

function CanvasViewer() {
  const { surfaces, connected, dispatchAction } = useCanvasStream()

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Canvas Surfaces</h2>
        <span className={`text-xs px-2 py-0.5 rounded-full ${connected ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>
      {surfaces.size === 0 ? (
        <p className="text-sm text-muted-foreground">No canvas surfaces active. The agent will create surfaces when it has visual output to display.</p>
      ) : (
        <div className="space-y-2">
          {Array.from(surfaces.values()).map((surface: Surface) => (
            <div key={surface.id} className="rounded border p-3">
              <div className="font-medium text-sm">{surface.title || surface.id}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {surface.components.length} components · {Object.keys(surface.data).length} data paths
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
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

  if (loading) return <div className="rounded-lg border p-4 animate-pulse bg-muted/50">Loading files...</div>

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <h2 className="text-lg font-semibold">Workspace Files</h2>
      {error && <div className="text-sm text-destructive">{error.message}</div>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1 max-h-[300px] overflow-y-auto">
          {tree && tree.length > 0 ? (
            tree.map((node, i) => (
              <FileTreeNode key={i} node={node} depth={0} onFileClick={handleFileClick} />
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No files in workspace</p>
          )}
        </div>
        {selectedContent !== null && (
          <div className="border rounded p-3">
            <div className="text-xs font-medium text-muted-foreground mb-2">{selectedPath}</div>
            <pre className="text-xs overflow-auto max-h-[250px] whitespace-pre-wrap">{selectedContent}</pre>
          </div>
        )}
      </div>
    </div>
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
          <span className="text-muted-foreground">{expanded ? '▼' : '▶'}</span>
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
      <span className="text-muted-foreground">📄</span>
      <span>{node.name}</span>
    </button>
  )
}

function ModeControl() {
  const { mode, loading, setMode } = useAgentMode()

  if (loading) return null

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <h2 className="text-lg font-semibold">Mode Control</h2>
      <div className="flex gap-2">
        {(['none', 'canvas', 'app'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              mode === m
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            {m}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b px-6 py-4">
        <h1 className="text-2xl font-bold">Agent Dashboard</h1>
        <p className="text-sm text-muted-foreground">Monitor, chat with, and control your AI agent</p>
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
}
