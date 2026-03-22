import { useState, useMemo, useRef, useEffect } from 'react'
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
import { LogOut, Send, ArrowUp, ArrowDown, Search } from 'lucide-react'

type DataRecord = Record<string, unknown>

function useAgentData() {
  const { surfaces, connected } = useCanvasStream()
  const [records, setRecords] = useState<DataRecord[]>([])
  const [columns, setColumns] = useState<string[]>([])
  const [title, setTitle] = useState('Data Explorer')

  useEffect(() => {
    for (const surface of surfaces.values()) {
      const data = surface.data
      for (const [, value] of Object.entries(data)) {
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
        <Card key={m.label}>
          <CardContent className="py-3">
            <div className="text-xs text-muted-foreground capitalize">{m.label}</div>
            <div className="text-xl font-bold mt-1">{m.total.toLocaleString()}</div>
            <div className="text-xs text-muted-foreground">avg: {m.avg.toFixed(1)}</div>
          </CardContent>
        </Card>
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
    <Card>
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
                  <span className="inline-flex items-center gap-1">
                    {col}
                    {sortCol === col && (sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                  </span>
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
    </Card>
  )
}

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return '\u2014'
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
    <Card className="flex flex-col h-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Ask About Data</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto space-y-2 min-h-0">
        {messages.length === 0 && (
          <p className="text-xs text-muted-foreground text-center mt-4">
            Ask your agent questions about the collected data
          </p>
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
          placeholder="Ask about the data..."
          disabled={isStreaming}
        />
        <Button onClick={handleSend} disabled={isStreaming || !input.trim()} size="icon">
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  )
}

const ExplorerContent = observer(function ExplorerContent() {
  const { auth } = useStores()
  const { records, columns, title, connected } = useAgentData()
  const [searchTerm, setSearchTerm] = useState('')

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">{title}</h1>
            <CardDescription>
              Explore data collected by your agent
              <span className={`ml-2 inline-block w-2 h-2 rounded-full align-middle ${connected ? 'bg-green-500' : 'bg-yellow-500'}`} />
            </CardDescription>
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
      <main className="max-w-7xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-3 space-y-6">
          <MetricsBar records={records} columns={columns} />
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search records..."
                className="pl-9"
              />
            </div>
            <span className="text-sm text-muted-foreground whitespace-nowrap">{records.length} records</span>
          </div>
          <DataTable records={records} columns={columns} searchTerm={searchTerm} />
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
      <ExplorerContent />
    </AuthGate>
  )
}
