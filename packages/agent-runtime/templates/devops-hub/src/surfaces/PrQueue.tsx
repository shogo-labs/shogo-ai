import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricCard } from '@/components/MetricCard'
import initialData from './PrQueue.data.json'

export default function PrQueue() {
  const [data] = useState(initialData)

  return (
    <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">PR Queue</h2>
          <Badge variant="outline">Connect GitHub to start</Badge>
        </div>
        <div className="grid grid-cols-4 gap-4">
          <MetricCard label="Open PRs" value={data.metrics.openPrs} />
          <MetricCard label="Awaiting Review" value={data.metrics.awaitingReview} />
          <MetricCard label="Stale (>48h)" value={data.metrics.stalePrs} />
          <MetricCard label="Merged (7d)" value={data.metrics.mergedWeek} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Pull Requests</CardTitle>
            <CardDescription>Open PRs sorted by age</CardDescription>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">Connect GitHub and I'll populate this with your open PRs, auto-review small changes, and flag stale PRs needing attention.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Getting Started</CardTitle>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">{"Say \"Connect my GitHub\" — I'll fetch your repos, triage PRs, and start auto-reviewing."}</p>
          </CardContent>
        </Card>
      </div>
  )
}
