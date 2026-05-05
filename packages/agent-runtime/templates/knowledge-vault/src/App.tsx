import { useState } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ThemeProvider, useTheme } from './components/ThemeProvider'
import { SearchBar } from './components/vault/SearchBar'
import { NoteList } from './components/vault/NoteList'
import { SynthesisCard } from './components/vault/SynthesisCard'
import { ResearchResult } from './components/vault/ResearchResult'
import { VaultHealth } from './components/vault/VaultHealth'
import type { Note, Synthesis, Research, VaultMetrics } from './components/vault/types'

// ── Data arrays — the agent fills these via the API ─────────────────────────

const notes: Note[] = []
const syntheses: Synthesis[] = []
const researches: Research[] = []
const vaultMetrics: VaultMetrics | null = null

// ── App Shell ───────────────────────────────────────────────────────────────

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  return (
    <button
      onClick={toggleTheme}
      className="p-2 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors text-sm"
      aria-label="Toggle theme"
    >
      {theme === 'dark' ? '☀️' : '🌙'}
    </button>
  )
}

function VaultDashboard() {
  const [activeTab, setActiveTab] = useState('vault')
  const [searchQuery, setSearchQuery] = useState('')

  const filteredNotes = searchQuery
    ? notes.filter(n =>
        n.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        n.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
        n.entities.some(e => e.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : notes

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800/50 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center text-lg">
              🧠
            </div>
            <div>
              <h1 className="text-lg font-semibold text-zinc-100">Knowledge Vault</h1>
              <p className="text-[11px] text-zinc-500">
                {notes.length} notes · {syntheses.length} syntheses · {researches.length} researches
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="outline" className="bg-zinc-900 text-zinc-400 border-zinc-800 text-[11px]">
              Rewrite-first
            </Badge>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-6">
        <div className="mb-6">
          <SearchBar onSearch={setSearchQuery} />
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="bg-zinc-900/50 border border-zinc-800">
            <TabsTrigger value="vault">Vault</TabsTrigger>
            <TabsTrigger value="synthesis">Synthesis</TabsTrigger>
            <TabsTrigger value="research">Research</TabsTrigger>
            <TabsTrigger value="health">Health</TabsTrigger>
          </TabsList>

          <div className="mt-6">
            <TabsContent value="vault">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium text-zinc-300">
                    {searchQuery ? `Results for "${searchQuery}"` : 'Recent Notes'}
                  </h2>
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className="text-[11px] text-zinc-500 hover:text-zinc-300"
                    >
                      Clear search
                    </button>
                  )}
                </div>
                <NoteList notes={filteredNotes} />
              </div>
            </TabsContent>

            <TabsContent value="synthesis">
              <div className="space-y-4">
                <h2 className="text-sm font-medium text-zinc-300">Cross-Source Patterns</h2>
                {syntheses.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <div className="text-4xl mb-3">🔗</div>
                    <h3 className="text-sm font-medium text-zinc-300">No synthesis yet</h3>
                    <p className="text-xs text-zinc-500 mt-1 max-w-sm">
                      After ingesting several sources, ask me to "synthesize" or "find patterns"
                      and I'll identify cross-source themes, trends, and tensions.
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-3">
                    {syntheses.map(s => (
                      <SynthesisCard key={s.id} synthesis={s} />
                    ))}
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="research">
              <div className="space-y-4">
                <h2 className="text-sm font-medium text-zinc-300">Research Results</h2>
                {researches.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <div className="text-4xl mb-3">🔍</div>
                    <h3 className="text-sm font-medium text-zinc-300">No research yet</h3>
                    <p className="text-xs text-zinc-500 mt-1 max-w-sm">
                      Ask me to "research" any topic. I'll check the vault first, identify gaps,
                      then search the web to fill them — always with citations.
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-3">
                    {researches.map(r => (
                      <ResearchResult key={r.id} research={r} />
                    ))}
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="health">
              <VaultHealth metrics={vaultMetrics} />
            </TabsContent>
          </div>
        </Tabs>

        <Card className="mt-8 bg-zinc-900/40 border-zinc-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-zinc-400">Getting Started</CardTitle>
            <CardDescription className="text-[11px] text-zinc-500">
              Your vault grows through ingestion, rewrites, and synthesis
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs text-zinc-400">
              <div>
                <p className="font-medium text-zinc-300 mb-1">Ingest</p>
                <p>"Save this article" or paste any URL, PDF, or text</p>
              </div>
              <div>
                <p className="font-medium text-zinc-300 mb-1">Synthesize</p>
                <p>"Find patterns" across your recent notes</p>
              </div>
              <div>
                <p className="font-medium text-zinc-300 mb-1">Challenge</p>
                <p>"Challenge my thinking" with your own vault history</p>
              </div>
              <div>
                <p className="font-medium text-zinc-300 mb-1">Research</p>
                <p>"Deep dive into X" — vault-first, then web</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <VaultDashboard />
    </ThemeProvider>
  )
}
