import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { CritiqueResult } from './types'

interface Props {
  critique: CritiqueResult
}

const VERDICT_STYLES: Record<string, string> = {
  SHIP: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  REVISE: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  REDESIGN: 'bg-red-500/10 text-red-500 border-red-500/20',
}

const SEVERITY_STYLES: Record<string, { dot: string; label: string }> = {
  critical: { dot: 'bg-red-500', label: 'text-red-500' },
  major: { dot: 'bg-amber-500', label: 'text-amber-500' },
  minor: { dot: 'bg-blue-500', label: 'text-blue-500' },
  nit: { dot: 'bg-zinc-400', label: 'text-zinc-400' },
}

export default function CritiquePanel({ critique }: Props) {
  const grouped = {
    critical: critique.findings.filter((f) => f.severity === 'critical'),
    major: critique.findings.filter((f) => f.severity === 'major'),
    minor: critique.findings.filter((f) => f.severity === 'minor'),
    nit: critique.findings.filter((f) => f.severity === 'nit'),
  }

  return (
    <ScrollArea className="h-[calc(100vh-180px)]">
      <div className="space-y-6 pr-4">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-bold">Design Critique</h2>
            <p className="text-sm text-muted-foreground mt-1">{critique.target}</p>
          </div>
          <Badge className={`text-sm px-3 py-1 ${VERDICT_STYLES[critique.verdict]}`}>
            {critique.verdict}
          </Badge>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {critique.reviewers.map((reviewer) => (
            <Card key={reviewer.role}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{reviewer.name}</CardTitle>
                <CardDescription>{reviewer.role}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-end gap-2">
                  <span className="text-3xl font-bold">{reviewer.score}</span>
                  <span className="text-sm text-muted-foreground mb-1">/10</span>
                </div>
                <p className="text-xs text-muted-foreground mt-2">{reviewer.summary}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Composite Score</CardTitle>
              <span className="text-2xl font-bold">{critique.compositeScore}/10</span>
            </div>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Findings</CardTitle>
            <CardDescription>
              {critique.findings.length} findings across {critique.reviewers.length} reviewers
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {(['critical', 'major', 'minor', 'nit'] as const).map((severity) => {
              const items = grouped[severity]
              if (items.length === 0) return null
              const styles = SEVERITY_STYLES[severity]
              return (
                <div key={severity}>
                  <p className={`text-xs font-semibold uppercase tracking-wider mb-2 ${styles.label}`}>
                    {severity} ({items.length})
                  </p>
                  <ul className="space-y-2">
                    {items.map((finding, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm p-2 rounded-md border border-border">
                        <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${styles.dot}`} />
                        <div className="space-y-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <Badge variant="outline" className="text-[9px]">{finding.status}</Badge>
                            <span className="text-xs text-muted-foreground">{finding.reviewer}</span>
                          </div>
                          <p>{finding.description}</p>
                          <p className="text-xs font-mono text-muted-foreground">{finding.location}</p>
                          <p className="text-xs text-emerald-600 dark:text-emerald-400">Fix: {finding.fix}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground leading-relaxed">{critique.summary}</p>
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  )
}
