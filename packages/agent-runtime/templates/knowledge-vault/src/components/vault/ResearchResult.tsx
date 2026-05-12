import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Research } from './types'

const statusColors: Record<Research['status'], string> = {
  complete: 'bg-green-500/20 text-green-300 border-green-500/30',
  in_progress: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  needs_followup: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
}

const statusLabels: Record<Research['status'], string> = {
  complete: 'Complete',
  in_progress: 'In Progress',
  needs_followup: 'Needs Follow-up',
}

const confidenceColors: Record<Research['confidence'], string> = {
  high: 'bg-green-500/20 text-green-300 border-green-500/30',
  medium: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  low: 'bg-red-500/20 text-red-300 border-red-500/30',
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return iso
  }
}

export function ResearchResult({ research }: { research: Research }) {
  return (
    <Card className="bg-zinc-900/60 border-zinc-800 hover:border-zinc-700 transition-colors">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1">
            <CardTitle className="text-sm font-medium text-zinc-100 leading-tight">
              {research.title}
            </CardTitle>
            <p className="text-[11px] text-zinc-500">
              Query: "{research.query}"
            </p>
          </div>
          <div className="flex gap-1.5 shrink-0">
            <Badge variant="outline" className={statusColors[research.status]}>
              {statusLabels[research.status]}
            </Badge>
            <Badge variant="outline" className={confidenceColors[research.confidence]}>
              {research.confidence}
            </Badge>
            <Badge variant="outline" className="bg-zinc-800 text-zinc-300 border-zinc-700">
              {research.mode}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        <p className="text-xs text-zinc-400 line-clamp-3">{research.findings}</p>

        {research.citations.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[11px] font-medium text-zinc-400">
              Citations ({research.citations.length})
            </p>
            <div className="space-y-1">
              {research.citations.slice(0, 3).map(citation => (
                <div key={citation.id} className="flex items-center justify-between text-[11px]">
                  <a
                    href={citation.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300 truncate max-w-[240px]"
                  >
                    {citation.source}
                  </a>
                  <div className="flex gap-2 text-zinc-500 shrink-0">
                    <span>{citation.date}</span>
                    <span className={
                      citation.confidence === 'high' ? 'text-green-400' :
                      citation.confidence === 'medium' ? 'text-yellow-400' : 'text-red-400'
                    }>
                      {citation.confidence}
                    </span>
                  </div>
                </div>
              ))}
              {research.citations.length > 3 && (
                <p className="text-[11px] text-zinc-500">
                  +{research.citations.length - 3} more source{research.citations.length - 3 !== 1 ? 's' : ''}
                </p>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center gap-4 text-[11px] text-zinc-500 pt-1 border-t border-zinc-800/50">
          {research.notesCreated > 0 && (
            <span>{research.notesCreated} notes created</span>
          )}
          {research.notesUpdated > 0 && (
            <span>{research.notesUpdated} notes updated</span>
          )}
          {research.contradictionsFound > 0 && (
            <span className="text-amber-400">{research.contradictionsFound} contradictions</span>
          )}
          <span className="ml-auto">{formatDate(research.createdAt)}</span>
        </div>
      </CardContent>
    </Card>
  )
}
