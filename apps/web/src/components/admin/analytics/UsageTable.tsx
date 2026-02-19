/**
 * UsageTable - Reusable table showing AI model usage by user.
 *
 * Supports two views:
 * 1. Summary view: aggregated by user + model (default)
 * 2. Detail view: individual usage events (paginated log)
 *
 * Designed to be reused for:
 * - Super admin portal (platform-wide, no scope)
 * - Workspace admin (scoped to workspace)
 */

import { useState, useMemo } from 'react'
import {
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Cpu,
  ArrowUpDown,
  User as UserIcon,
  Zap,
  Clock,
} from 'lucide-react'

// =============================================================================
// Types
// =============================================================================

export interface UsageSummaryEntry {
  userId: string
  userName: string | null
  userEmail: string
  userImage: string | null
  model: string
  provider: string
  requestCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  totalCredits: number
  avgDurationMs: number
}

export interface UsageLogEntry {
  id: string
  userId: string
  userName: string | null
  userEmail: string
  userImage: string | null
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  creditCost: number
  durationMs: number
  success: boolean
  createdAt: string
}

export interface UsageSummaryData {
  summaries: UsageSummaryEntry[]
  totals: {
    totalRequests: number
    totalInputTokens: number
    totalOutputTokens: number
    totalTokens: number
    totalCredits: number
    totalToolCalls: number
    uniqueUsers: number
    uniqueModels: number
  }
}

export interface UsageLogData {
  entries: UsageLogEntry[]
  total: number
  page: number
  limit: number
}

interface UsageTableProps {
  summaryData: UsageSummaryData | null
  logData: UsageLogData | null
  summaryLoading?: boolean
  logLoading?: boolean
  onPageChange?: (page: number) => void
  currentPage?: number
  /** Hide token count columns (input/output/total). Useful for workspace team view. */
  hideTokens?: boolean
}

// =============================================================================
// Helpers
// =============================================================================

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${ms}ms`
}

function getModelColor(model: string): string {
  if (model.includes('opus')) return 'bg-purple-500/15 text-purple-400 border-purple-500/20'
  if (model.includes('sonnet')) return 'bg-blue-500/15 text-blue-400 border-blue-500/20'
  if (model.includes('haiku')) return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20'
  if (model.includes('gpt-4o-mini') || model.includes('o1-mini') || model.includes('o3-mini'))
    return 'bg-teal-500/15 text-teal-400 border-teal-500/20'
  if (model.includes('gpt') || model.includes('o1') || model.includes('o3'))
    return 'bg-green-500/15 text-green-400 border-green-500/20'
  return 'bg-muted text-muted-foreground border-border'
}

function getModelDisplayName(model: string): string {
  if (!model) return 'Unknown Model'
  const map: Record<string, string> = {
    'claude-opus-4-6': 'Claude Opus 4.6',
    'claude-sonnet-4-5': 'Claude Sonnet 4.5',
    'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5',
    'claude-haiku-4-5': 'Claude Haiku 4.5',
    'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
    'claude-opus-4-5-20251101': 'Claude Opus 4.5',
    'claude-sonnet-4-20250514': 'Claude Sonnet 4',
    'claude-sonnet-4': 'Claude Sonnet 4',
    'claude-3-7-sonnet-20250219': 'Claude 3.7 Sonnet',
    'claude-opus-4-20250514': 'Claude Opus 4',
    'claude-opus-4': 'Claude Opus 4',
    'claude-3-haiku-20240307': 'Claude 3 Haiku',
    'gpt-4o': 'GPT-4o',
    'gpt-4o-mini': 'GPT-4o Mini',
    'gpt-4-turbo': 'GPT-4 Turbo',
    'o1': 'o1',
    'o1-mini': 'o1 Mini',
    'o3-mini': 'o3 Mini',
  }
  return map[model] || model
}

type SortKey = 'userEmail' | 'model' | 'requestCount' | 'totalInputTokens' | 'totalOutputTokens' | 'totalTokens' | 'totalCredits'
type SortDir = 'asc' | 'desc'

// =============================================================================
// Summary View
// =============================================================================

function SummaryView({ data, hideTokens }: { data: UsageSummaryData; hideTokens?: boolean }) {
  const [sortKey, setSortKey] = useState<SortKey>('totalTokens')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const sorted = useMemo(() => {
    return [...data.summaries].sort((a, b) => {
      const va = a[sortKey] ?? ''
      const vb = b[sortKey] ?? ''
      const cmp = typeof va === 'number' ? (va as number) - (vb as number) : String(va).localeCompare(String(vb))
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [data.summaries, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown className="h-3 w-3 opacity-40" />
    return sortDir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
  }

  return (
    <div>
      {/* Totals bar */}
      <div className={`grid grid-cols-2 sm:grid-cols-4 ${hideTokens ? 'lg:grid-cols-5' : 'lg:grid-cols-6'} gap-3 mb-5`}>
        <div className="p-3 rounded-lg bg-muted/40 border border-border/50">
          <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
            <UserIcon className="h-3 w-3" />Users
          </div>
          <div className="text-lg font-bold">{data.totals.uniqueUsers}</div>
        </div>
        <div className="p-3 rounded-lg bg-muted/40 border border-border/50">
          <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
            <Cpu className="h-3 w-3" />Models
          </div>
          <div className="text-lg font-bold">{data.totals.uniqueModels}</div>
        </div>
        <div className="p-3 rounded-lg bg-muted/40 border border-border/50">
          <div className="text-xs text-muted-foreground mb-1">Requests</div>
          <div className="text-lg font-bold">{formatNumber(data.totals.totalRequests)}</div>
        </div>
        {!hideTokens && (
          <div className="p-3 rounded-lg bg-muted/40 border border-border/50">
            <div className="text-xs text-muted-foreground mb-1">Total Tokens</div>
            <div className="text-lg font-bold">{formatNumber(data.totals.totalTokens)}</div>
          </div>
        )}
        <div className="p-3 rounded-lg bg-muted/40 border border-border/50">
          <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
            <Zap className="h-3 w-3" />Tool Calls
          </div>
          <div className="text-lg font-bold">{formatNumber(data.totals.totalToolCalls)}</div>
        </div>
        <div className="p-3 rounded-lg bg-muted/40 border border-border/50">
          <div className="text-xs text-muted-foreground mb-1">Credits</div>
          <div className="text-lg font-bold">{data.totals.totalCredits.toFixed(1)}</div>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/30 border-b border-border">
              <th className="text-left p-3 font-medium">
                <button className="flex items-center gap-1 hover:text-foreground transition-colors" onClick={() => toggleSort('userEmail')}>
                  User <SortIcon col="userEmail" />
                </button>
              </th>
              <th className="text-left p-3 font-medium">
                <button className="flex items-center gap-1 hover:text-foreground transition-colors" onClick={() => toggleSort('model')}>
                  Model <SortIcon col="model" />
                </button>
              </th>
              <th className="text-right p-3 font-medium">
                <button className="flex items-center gap-1 justify-end hover:text-foreground transition-colors" onClick={() => toggleSort('requestCount')}>
                  Requests <SortIcon col="requestCount" />
                </button>
              </th>
              {!hideTokens && (
                <>
                  <th className="text-right p-3 font-medium">
                    <button className="flex items-center gap-1 justify-end hover:text-foreground transition-colors" onClick={() => toggleSort('totalInputTokens')}>
                      Input Tokens <SortIcon col="totalInputTokens" />
                    </button>
                  </th>
                  <th className="text-right p-3 font-medium">
                    <button className="flex items-center gap-1 justify-end hover:text-foreground transition-colors" onClick={() => toggleSort('totalOutputTokens')}>
                      Output Tokens <SortIcon col="totalOutputTokens" />
                    </button>
                  </th>
                  <th className="text-right p-3 font-medium">
                    <button className="flex items-center gap-1 justify-end hover:text-foreground transition-colors" onClick={() => toggleSort('totalTokens')}>
                      Total Tokens <SortIcon col="totalTokens" />
                    </button>
                  </th>
                </>
              )}
              <th className="text-right p-3 font-medium">
                <button className="flex items-center gap-1 justify-end hover:text-foreground transition-colors" onClick={() => toggleSort('totalCredits')}>
                  Credits <SortIcon col="totalCredits" />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={hideTokens ? 4 : 7} className="p-8 text-center text-muted-foreground">
                  No usage data for this period
                </td>
              </tr>
            ) : (
              sorted.map((entry, i) => (
                <tr
                  key={`${entry.userId}-${entry.model}`}
                  className={`border-b border-border/50 hover:bg-muted/20 transition-colors ${
                    i % 2 === 0 ? '' : 'bg-muted/10'
                  }`}
                >
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      {entry.userImage ? (
                        <img src={entry.userImage} alt="" className="h-6 w-6 rounded-full" />
                      ) : (
                        <div className="h-6 w-6 rounded-full bg-primary/20 flex items-center justify-center text-xs font-medium text-primary">
                          {(entry.userName || entry.userEmail)[0]?.toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="font-medium text-foreground truncate text-xs">
                          {entry.userName || entry.userEmail.split('@')[0]}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">{entry.userEmail}</div>
                      </div>
                    </div>
                  </td>
                  <td className="p-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${getModelColor(entry.model)}`}>
                      {getModelDisplayName(entry.model)}
                    </span>
                  </td>
                  <td className="p-3 text-right font-mono text-xs">{entry.requestCount.toLocaleString()}</td>
                  {!hideTokens && (
                    <>
                      <td className="p-3 text-right font-mono text-xs text-muted-foreground">{formatNumber(entry.totalInputTokens)}</td>
                      <td className="p-3 text-right font-mono text-xs text-muted-foreground">{formatNumber(entry.totalOutputTokens)}</td>
                      <td className="p-3 text-right font-mono text-xs font-medium">{formatNumber(entry.totalTokens)}</td>
                    </>
                  )}
                  <td className="p-3 text-right font-mono text-xs">{entry.totalCredits.toFixed(1)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// =============================================================================
// Detail View (Event Log)
// =============================================================================

function DetailView({
  data,
  onPageChange,
  currentPage = 1,
  hideTokens,
}: {
  data: UsageLogData
  onPageChange?: (page: number) => void
  currentPage?: number
  hideTokens?: boolean
}) {
  const totalPages = Math.ceil(data.total / data.limit)

  return (
    <div>
      <div className="text-xs text-muted-foreground mb-3">
        Showing {data.entries.length} of {data.total.toLocaleString()} events
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/30 border-b border-border">
              <th className="text-left p-3 font-medium">Date</th>
              <th className="text-left p-3 font-medium">User</th>
              <th className="text-left p-3 font-medium">Model</th>
              {!hideTokens && (
                <>
                  <th className="text-right p-3 font-medium">Input</th>
                  <th className="text-right p-3 font-medium">Output</th>
                  <th className="text-right p-3 font-medium">Total</th>
                </>
              )}
              <th className="text-right p-3 font-medium">Credits</th>
              <th className="text-right p-3 font-medium">
                <Clock className="h-3 w-3 inline" />
              </th>
            </tr>
          </thead>
          <tbody>
            {data.entries.length === 0 ? (
              <tr>
                <td colSpan={hideTokens ? 5 : 8} className="p-8 text-center text-muted-foreground">
                  No usage events for this period
                </td>
              </tr>
            ) : (
              data.entries.map((entry, i) => (
                <tr
                  key={entry.id}
                  className={`border-b border-border/50 hover:bg-muted/20 transition-colors ${
                    i % 2 === 0 ? '' : 'bg-muted/10'
                  }`}
                >
                  <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(entry.createdAt).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      {entry.userImage ? (
                        <img src={entry.userImage} alt="" className="h-5 w-5 rounded-full" />
                      ) : (
                        <div className="h-5 w-5 rounded-full bg-primary/20 flex items-center justify-center text-xs font-medium text-primary">
                          {(entry.userName || entry.userEmail)[0]?.toUpperCase()}
                        </div>
                      )}
                      <span className="text-xs font-medium truncate max-w-[120px]">
                        {entry.userName || entry.userEmail.split('@')[0]}
                      </span>
                    </div>
                  </td>
                  <td className="p-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${getModelColor(entry.model)}`}>
                      {getModelDisplayName(entry.model)}
                    </span>
                  </td>
                  {!hideTokens && (
                    <>
                      <td className="p-3 text-right font-mono text-xs text-muted-foreground">{formatNumber(entry.inputTokens)}</td>
                      <td className="p-3 text-right font-mono text-xs text-muted-foreground">{formatNumber(entry.outputTokens)}</td>
                      <td className="p-3 text-right font-mono text-xs font-medium">{formatNumber(entry.totalTokens)}</td>
                    </>
                  )}
                  <td className="p-3 text-right font-mono text-xs">{entry.creditCost.toFixed(1)}</td>
                  <td className="p-3 text-right text-xs text-muted-foreground">{formatDuration(entry.durationMs)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <div className="text-xs text-muted-foreground">
            Page {currentPage} of {totalPages}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => onPageChange?.(currentPage - 1)}
              disabled={currentPage <= 1}
              className="p-1.5 rounded-md border border-border hover:bg-muted/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => onPageChange?.(currentPage + 1)}
              disabled={currentPage >= totalPages}
              className="p-1.5 rounded-md border border-border hover:bg-muted/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// =============================================================================
// Loading Skeleton
// =============================================================================

function TableSkeleton() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-16 bg-muted/30 rounded-lg animate-pulse" />
        ))}
      </div>
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="h-10 bg-muted/30 animate-pulse" />
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-12 bg-muted/10 animate-pulse border-t border-border/30" />
        ))}
      </div>
    </div>
  )
}

// =============================================================================
// Main Component
// =============================================================================

export function UsageTable({
  summaryData,
  logData,
  summaryLoading,
  logLoading,
  onPageChange,
  currentPage = 1,
  hideTokens,
}: UsageTableProps) {
  const [view, setView] = useState<'summary' | 'detail'>('summary')

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-center justify-between mb-5">
        <h3 className="text-sm font-semibold">AI Usage by User</h3>
        <div className="flex items-center rounded-lg border border-border overflow-hidden text-xs">
          <button
            onClick={() => setView('summary')}
            className={`px-3 py-1.5 transition-colors ${
              view === 'summary'
                ? 'bg-primary text-primary-foreground'
                : 'hover:bg-muted/50 text-muted-foreground'
            }`}
          >
            Summary
          </button>
          <button
            onClick={() => setView('detail')}
            className={`px-3 py-1.5 transition-colors ${
              view === 'detail'
                ? 'bg-primary text-primary-foreground'
                : 'hover:bg-muted/50 text-muted-foreground'
            }`}
          >
            Event Log
          </button>
        </div>
      </div>

      {view === 'summary' ? (
        summaryLoading ? (
          <TableSkeleton />
        ) : summaryData ? (
          <SummaryView data={summaryData} hideTokens={hideTokens} />
        ) : (
          <div className="py-12 text-center text-muted-foreground text-sm">
            No usage data available
          </div>
        )
      ) : logLoading ? (
        <TableSkeleton />
      ) : logData ? (
        <DetailView data={logData} onPageChange={onPageChange} currentPage={currentPage} hideTokens={hideTokens} />
      ) : (
        <div className="py-12 text-center text-muted-foreground text-sm">
          No usage events available
        </div>
      )}
    </div>
  )
}
