import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import initialData from './ReviewPanel.data.json'

type Verdict = 'ship' | 'revise' | 'kill'

interface Review {
  plan: string
  reviewer: 'ceo' | 'engineering' | 'design'
  verdict: Verdict
  rationale: string
  topRisk: string
  at: string
}

const REVIEWERS: Record<Review['reviewer'], { label: string; className: string }> = {
  ceo: { label: 'CEO Plan Reviewer', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  engineering: { label: 'Engineering Plan Reviewer', className: 'bg-blue-500/15 text-blue-700 dark:text-blue-300' },
  design: { label: 'Design Plan Reviewer', className: 'bg-violet-500/15 text-violet-700 dark:text-violet-300' },
}

const VERDICTS: Record<Verdict, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  ship: { label: 'Ship', variant: 'default' },
  revise: { label: 'Revise', variant: 'secondary' },
  kill: { label: 'Kill', variant: 'destructive' },
}

export default function ReviewPanel() {
  const [data] = useState(initialData)
  const reviews = data.reviews as Review[]

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">Review Panel</h2>
        <Badge variant="outline">{reviews.length} reviews</Badge>
      </div>

      {reviews.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No plans in review</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {"Drop a plan in chat (strategy, tech, or design) and it'll be routed to the right reviewer. Verdicts land here."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {reviews.map((r, i) => {
            const reviewer = REVIEWERS[r.reviewer]
            const verdict = VERDICTS[r.verdict]
            return (
              <Card key={i}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{r.plan}</CardTitle>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded ${reviewer.className}`}>
                        {reviewer.label}
                      </span>
                      <Badge variant={verdict.variant}>{verdict.label}</Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm font-medium">{r.rationale}</p>
                  <p className="text-sm text-muted-foreground mt-2">
                    <span className="font-semibold">Top risk:</span> {r.topRisk}
                  </p>
                  <p className="text-xs text-muted-foreground mt-2">{r.at}</p>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
