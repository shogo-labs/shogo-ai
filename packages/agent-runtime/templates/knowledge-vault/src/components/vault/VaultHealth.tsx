import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { VaultMetrics } from './types'

function MetricTile({ label, value, detail, color }: {
  label: string
  value: string | number
  detail?: string
  color?: 'green' | 'amber' | 'red' | 'blue' | 'zinc'
}) {
  const textColor = {
    green: 'text-green-400',
    amber: 'text-amber-400',
    red: 'text-red-400',
    blue: 'text-blue-400',
    zinc: 'text-zinc-100',
  }[color ?? 'zinc']

  return (
    <Card className="bg-zinc-900/60 border-zinc-800">
      <CardContent className="pt-5 pb-4">
        <p className="text-[11px] text-zinc-500 uppercase tracking-wider">{label}</p>
        <p className={`text-2xl font-bold mt-1 ${textColor}`}>{value}</p>
        {detail && <p className="text-[11px] text-zinc-500 mt-1">{detail}</p>}
      </CardContent>
    </Card>
  )
}

interface VaultHealthProps {
  metrics: VaultMetrics | null
}

export function VaultHealth({ metrics }: VaultHealthProps) {
  if (!metrics) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="text-4xl mb-3">📊</div>
        <h3 className="text-sm font-medium text-zinc-300">No health data yet</h3>
        <p className="text-xs text-zinc-500 mt-1 max-w-sm">
          Health metrics will appear after your first heartbeat cycle scans the vault.
        </p>
      </div>
    )
  }

  const stalenessPercent = metrics.totalNotes > 0
    ? Math.round((metrics.staleNotes / metrics.totalNotes) * 100)
    : 0

  const stalenessColor = stalenessPercent > 30 ? 'red' : stalenessPercent > 15 ? 'amber' : 'green'
  const orphanColor = metrics.orphanCount > 10 ? 'red' : metrics.orphanCount > 5 ? 'amber' : 'green'
  const contradictionColor = metrics.unresolvedContradictions > 5 ? 'red' : metrics.unresolvedContradictions > 2 ? 'amber' : 'green'

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-3">Vault Overview</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricTile label="Total Notes" value={metrics.totalNotes} color="blue" />
          <MetricTile
            label="This Week"
            value={`+${metrics.notesThisWeek}`}
            detail="new notes"
            color="green"
          />
          <MetricTile label="Total Sources" value={metrics.totalSources} color="zinc" />
          <MetricTile label="Syntheses" value={metrics.synthesisCount} color="blue" />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-3">Health Indicators</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricTile
            label="Orphan Notes"
            value={metrics.orphanCount}
            detail="no inbound links"
            color={orphanColor}
          />
          <MetricTile
            label="Contradictions"
            value={metrics.unresolvedContradictions}
            detail={`of ${metrics.contradictionCount} total`}
            color={contradictionColor}
          />
          <MetricTile
            label="Stale Notes"
            value={metrics.staleNotes}
            detail={`${stalenessPercent}% of vault`}
            color={stalenessColor}
          />
          <MetricTile
            label="Avg Confidence"
            value={`${Math.round(metrics.averageConfidence * 100)}%`}
            color={metrics.averageConfidence > 0.7 ? 'green' : metrics.averageConfidence > 0.4 ? 'amber' : 'red'}
          />
        </div>
      </div>

      <Card className="bg-zinc-900/60 border-zinc-800">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-zinc-400">Health Summary</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="space-y-2 text-xs text-zinc-400">
            {metrics.orphanCount > 0 && (
              <p>
                <span className="text-amber-400">→</span> {metrics.orphanCount} orphan note{metrics.orphanCount !== 1 ? 's' : ''} with
                no inbound links — consider connecting them to related topics.
              </p>
            )}
            {metrics.unresolvedContradictions > 0 && (
              <p>
                <span className="text-amber-400">→</span> {metrics.unresolvedContradictions} unresolved
                contradiction{metrics.unresolvedContradictions !== 1 ? 's' : ''} need reconciliation.
              </p>
            )}
            {metrics.staleNotes > 0 && (
              <p>
                <span className="text-amber-400">→</span> {metrics.staleNotes} note{metrics.staleNotes !== 1 ? 's' : ''} not
                verified in 30+ days — consider re-checking sources.
              </p>
            )}
            {metrics.orphanCount === 0 && metrics.unresolvedContradictions === 0 && metrics.staleNotes === 0 && (
              <p className="text-green-400">All clear — your vault is healthy.</p>
            )}
          </div>
        </CardContent>
      </Card>

      {metrics.lastUpdated && (
        <p className="text-[11px] text-zinc-600 text-right">
          Last scanned: {new Date(metrics.lastUpdated).toLocaleString()}
        </p>
      )}
    </div>
  )
}
