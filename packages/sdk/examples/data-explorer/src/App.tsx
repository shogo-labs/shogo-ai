import { useState, useMemo, useRef, useEffect } from 'react'
import {
  useAgentStatus,
  useAgentChat,
  useCanvasStream,
  type Surface,
} from '@shogo-ai/sdk/agent'

type DataRecord = Record<string, unknown>

function useAgentData() {
  const { surfaces, connected } = useCanvasStream()
  const [records, setRecords] = useState<DataRecord[]>([])
  const [columns, setColumns] = useState<string[]>([])
  const [title, setTitle] = useState('Data Explorer')

  useEffect(() => {
    for (const surface of surfaces.values()) {
      const data = surface.data
      for (const [key, value] of Object.entries(data)) {
        if (Array.isArray(value) && value.length > 0) {
          setRecords(value)
          const cols = Object.keys(value[0] as object).filter((k) => k !== 'id')
          setColumns(cols)
          if (surface.title) setTitle(surface.title)
          break
        }
      }
    }
  }, [surfaces])

  return { records, columns, title, connected }
}

function StatusBar() {
  const { status } = useAgentStatus({ pollInterval: 5000 })

  return (
    <div className="flex items-center gap-3 text-sm">
      <span className={`w-2 h-2 rounded-full ${status?.status === 'running' ? 'bg-green-500' : 'bg-yellow-500'}`} />
      <span className="text-muted-foreground">{status?.status ?? 'connecting...'}</span>
    </div>
  )
}

function MetricsBar({ records, columns }: { records: DataRecord[]; columns: string[] }) {
  const numericColumns = columns.filter((col) =>
    records.some((r) => typeof r[col] === 'number'),
  )

  if (numericColumns.length === 0) return null

  const metrics = numericColumns.slice(0, 4).map((col) => {
    const values = records.map((r) => Number(r[col]) || 0)
    const sum = values.reduce((a, b) => a + b, 0)
    const avg = values.length > 0 ? sum / values.length : 0
    return { label: col, total: sum, avg, count: values.length }
  })

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {metrics.map((m) => (
        <div key={m.label} className="rounded-lg border p-3">
          <div className="text-xs text-muted-foreground capitalize">{m.label}</div>
          <div className="text-xl font-bold mt-1">{m.total.toLocaleString()}</div>
          <div className="text-xs text-muted-foreground">avg: {m.avg.toFixed(1)}</div>
        </div>
      ))}
    </div>
  )
}

function DataTable({
  records,
  columns,
  searchTerm,
}: {
  records: DataRecord[]
  columns: string[]
  searchTerm: string
}) {
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const filtered = useMemo(() => {
    let data = records
    if (searchTerm) {
      const term = searchTerm.toLowerCase()
      data = data.filter((r) =>
        columns.some((col) => String(r[col] ?? '').toLowerCase().includes(term)),
      )
    }
    if (sortCol) {
      data = [...data].sort((a, b) => {
        const aVal = a[sortCol] ?? ''
        const bVal = b[sortCol] ?? ''
        const cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true })
        return sortDir === 'asc' ? cmp : -cmp
      })
    }
    return data
  }, [records, columns, searchTerm, sortCol, sortDir])

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortCol(col)
      setSortDir('asc')
    }
  }

  return (
    <div className="rounded-lg border overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              {columns.map((col) => (
                <th
                  key={col}
                  onClick={() => handleSort(col)}
                  className="px-4 py-2 text-left font-medium cursor-pointer hover:bg-muted capitalize"
                >
                  {col}
                  {sortCol === col && (sortDir === 'asc' ? ' ↑' : ' ↓')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-8 text-center text-muted-foreground">
                  {searchTerm ? 'No matching records' : 'No data collected yet. Your agent will populate this as it works.'}
                </td>
              </tr>
            ) : (
              filtered.map((record, i) => (
                <tr key={i} className="border-b hover:bg-muted/30">
                  {columns.map((col) => (
                    <td key={col} className="px-4 py-2 truncate max-w-[200px]">
                      {formatValue(record[col])}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2 border-t text-xs text-muted-foreground">
        {filtered.length} of {records.length} records
      </div>
    </div>
  )
}

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return '—'
  if (typeof val === 'boolean') return val ? 'Yes' : 'No'
  if (typeof val === 'number') return val.toLocaleString()
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
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
        <h2 className="font-semibold">Ask About Data</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
        {messages.length === 0 && (
          <p className="text-xs text-muted-foreground text-center mt-4">
            Ask your agent questions about the collected data
          </p>
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
          placeholder="Ask about the data..."
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
  const { records, columns, title, connected } = useAgentData()
  const [searchTerm, setSearchTerm] = useState('')

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{title}</h1>
          <p className="text-sm text-muted-foreground">
            Explore data collected by your agent
            <span className={`ml-2 inline-block w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-yellow-500'}`} />
          </p>
        </div>
        <StatusBar />
      </header>
      <main className="max-w-7xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-3 space-y-6">
          <MetricsBar records={records} columns={columns} />
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search records..."
              className="flex-1 rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <span className="text-sm text-muted-foreground">{records.length} records</span>
          </div>
          <DataTable records={records} columns={columns} searchTerm={searchTerm} />
        </div>
        <div className="lg:col-span-1 h-[600px]">
          <ChatSidebar />
        </div>
      </main>
    </div>
  )
}
