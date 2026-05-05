import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Note } from './types'

const entityColors: Record<Note['entityType'], string> = {
  concept: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  person: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
  company: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  technology: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  event: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
  decision: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
  claim: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
}

const confidenceColors: Record<Note['confidence'], string> = {
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

export function NoteCard({ note }: { note: Note }) {
  return (
    <Card className="bg-zinc-900/60 border-zinc-800 hover:border-zinc-700 transition-colors">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-medium text-zinc-100 leading-tight">
            {note.title}
          </CardTitle>
          <div className="flex gap-1.5 shrink-0">
            <Badge variant="outline" className={entityColors[note.entityType]}>
              {note.entityType}
            </Badge>
            <Badge variant="outline" className={confidenceColors[note.confidence]}>
              {note.confidence}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        <p className="text-xs text-zinc-400 line-clamp-2">{note.content}</p>

        <div className="flex flex-wrap gap-1">
          {note.entities.map(entity => (
            <span key={entity} className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
              {entity}
            </span>
          ))}
        </div>

        <div className="flex items-center justify-between text-[11px] text-zinc-500">
          <span className="truncate max-w-[180px]" title={note.source}>
            {note.source}
          </span>
          <div className="flex gap-3 shrink-0">
            <span>Verified {formatDate(note.lastVerified)}</span>
            <span>Updated {formatDate(note.updatedAt)}</span>
          </div>
        </div>

        {note.relatedNotes.length > 0 && (
          <div className="text-[11px] text-zinc-500">
            {note.relatedNotes.length} linked note{note.relatedNotes.length !== 1 ? 's' : ''}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
