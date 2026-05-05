import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Synthesis } from './types'

const patternIcons: Record<Synthesis['patternType'], string> = {
  theme: '🔁',
  trend: '📈',
  tension: '⚡',
  gap: '🕳️',
  convergence: '🎯',
}

const patternColors: Record<Synthesis['patternType'], string> = {
  theme: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  trend: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  tension: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  gap: 'bg-red-500/20 text-red-300 border-red-500/30',
  convergence: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
}

const confidenceColors: Record<Synthesis['confidence'], string> = {
  high: 'bg-green-500/20 text-green-300 border-green-500/30',
  medium: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  low: 'bg-red-500/20 text-red-300 border-red-500/30',
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}

export function SynthesisCard({ synthesis }: { synthesis: Synthesis }) {
  return (
    <Card className="bg-zinc-900/60 border-zinc-800 hover:border-zinc-700 transition-colors">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-lg">{patternIcons[synthesis.patternType]}</span>
            <CardTitle className="text-sm font-medium text-zinc-100 leading-tight">
              {synthesis.title}
            </CardTitle>
          </div>
          <div className="flex gap-1.5 shrink-0">
            <Badge variant="outline" className={patternColors[synthesis.patternType]}>
              {synthesis.patternType}
            </Badge>
            <Badge variant="outline" className={confidenceColors[synthesis.confidence]}>
              {synthesis.confidence}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        <p className="text-xs text-zinc-400">{synthesis.pattern}</p>

        <div className="flex items-center justify-between text-[11px] text-zinc-500">
          <span>
            {synthesis.evidenceCount} evidence note{synthesis.evidenceCount !== 1 ? 's' : ''}
          </span>
          <div className="flex gap-3">
            <span>Window: {synthesis.timeWindow}</span>
            <span>{formatDate(synthesis.createdAt)}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
