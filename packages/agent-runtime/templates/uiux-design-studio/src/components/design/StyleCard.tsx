import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { UIStyle } from './types'

interface Props {
  style: UIStyle
}

const TIER_COLORS: Record<number, string> = {
  1: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  2: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  3: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  4: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
  5: 'bg-rose-500/10 text-rose-500 border-rose-500/20',
  6: 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20',
}

const STYLE_PREVIEWS: Record<string, { bg: string; accent: string; pattern: string }> = {
  Glassmorphism: { bg: 'from-blue-500/20 to-purple-500/20', accent: 'bg-white/20 backdrop-blur-sm border-white/30', pattern: 'blur' },
  Neumorphism: { bg: 'from-zinc-200 to-zinc-300 dark:from-zinc-700 dark:to-zinc-800', accent: 'bg-zinc-200 dark:bg-zinc-700 shadow-inner', pattern: 'shadow' },
  Brutalism: { bg: 'from-yellow-400 to-yellow-300', accent: 'bg-black border-2 border-black', pattern: 'bold' },
  'Bento Grid': { bg: 'from-zinc-100 to-zinc-200 dark:from-zinc-800 dark:to-zinc-900', accent: 'bg-zinc-50 dark:bg-zinc-800 rounded-2xl', pattern: 'grid' },
  'AI-Native': { bg: 'from-violet-500/20 to-blue-500/20', accent: 'bg-gradient-to-r from-violet-500 to-blue-500', pattern: 'gradient' },
}

export default function StyleCard({ style }: Props) {
  const tierColor = TIER_COLORS[style.tier] ?? TIER_COLORS[1]
  const preview = STYLE_PREVIEWS[style.name]

  return (
    <Card className="group cursor-pointer hover:border-primary/50 transition-all duration-200 hover:shadow-md overflow-hidden">
      <div
        className={`h-24 bg-gradient-to-br ${preview?.bg ?? 'from-zinc-300 to-zinc-400 dark:from-zinc-700 dark:to-zinc-800'} relative`}
      >
        <div className="absolute inset-0 flex items-center justify-center p-3">
          <div className={`w-full h-full rounded-lg ${preview?.accent ?? 'bg-white/30 dark:bg-black/20'} border border-border/50`} />
        </div>
      </div>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold leading-tight">{style.name}</p>
          <Badge variant="outline" className={`text-[9px] shrink-0 ${tierColor}`}>
            T{style.tier}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2">{style.bestFor}</p>
        <div className="flex flex-wrap gap-1 pt-1">
          {style.characteristics.slice(0, 3).map((c) => (
            <Badge key={c} variant="secondary" className="text-[9px]">
              {c}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
