import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import ColorSwatches from './ColorSwatches'
import TypographyPreview from './TypographyPreview'
import type { DesignSystem } from './types'

interface Props {
  system: DesignSystem
}

export default function DesignSystemView({ system }: Props) {
  return (
    <ScrollArea className="h-[calc(100vh-180px)]">
      <div className="space-y-6 pr-4">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-bold">{system.projectName}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {system.domain} &middot; {system.category}
            </p>
          </div>
          <Badge variant="outline">{system.audience}</Badge>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Pattern</CardTitle>
              <CardDescription>{system.pattern.name}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{system.pattern.rationale}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Style</CardTitle>
              <CardDescription className="flex items-center gap-2">
                {system.style.name}
                <Badge variant="outline" className="text-[10px]">Tier {system.style.tier}</Badge>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-1">
                {system.style.characteristics.map((c) => (
                  <Badge key={c} variant="secondary" className="text-xs">{c}</Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <ColorSwatches palette={system.colors} />
        <TypographyPreview typography={system.typography} />

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Effects</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <EffectItem label="Shadows" value={system.effects.shadows} />
              <EffectItem label="Border Radius" value={system.effects.borderRadius} />
              <EffectItem label="Transitions" value={system.effects.transitions} />
            </div>
            {system.effects.extras.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-border">
                {system.effects.extras.map((e) => (
                  <Badge key={e} variant="outline" className="text-xs">{e}</Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Anti-Patterns</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {system.antiPatterns.critical.length > 0 && (
              <AntiPatternGroup severity="Critical" items={system.antiPatterns.critical} color="text-red-500" />
            )}
            {system.antiPatterns.major.length > 0 && (
              <AntiPatternGroup severity="Major" items={system.antiPatterns.major} color="text-amber-500" />
            )}
            {system.antiPatterns.minor.length > 0 && (
              <AntiPatternGroup severity="Minor" items={system.antiPatterns.minor} color="text-blue-500" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Pre-Delivery Checklist</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {system.checklist.map((item, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className={`mt-0.5 shrink-0 ${item.done ? 'text-emerald-500' : 'text-muted-foreground'}`}>
                    {item.done ? '✓' : '○'}
                  </span>
                  <span className={item.done ? 'text-muted-foreground line-through' : ''}>{item.label}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  )
}

function EffectItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-2.5 rounded-md border border-border space-y-1">
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className="text-sm font-mono">{value}</p>
    </div>
  )
}

function AntiPatternGroup({ severity, items, color }: { severity: string; items: string[]; color: string }) {
  return (
    <div>
      <p className={`text-xs font-semibold uppercase tracking-wider mb-1.5 ${color}`}>{severity}</p>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="text-sm text-muted-foreground flex items-start gap-1.5">
            <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${color.replace('text-', 'bg-')}`} />
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}
