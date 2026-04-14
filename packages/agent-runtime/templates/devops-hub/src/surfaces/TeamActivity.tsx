import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricCard } from '@/components/MetricCard'
import initialData from './TeamActivity.data.json'

export default function TeamActivity() {
  const [data] = useState(initialData)

  return (
    <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Team Activity</h2>
          <Badge variant="outline">Not yet generated</Badge>
        </div>
        <div className="grid grid-cols-4 gap-4">
          <MetricCard label="Commits (24h)" value={data.metrics.commits} />
          <MetricCard label="PRs Merged" value={data.metrics.prsMerged} />
          <MetricCard label="Reviews" value={data.metrics.reviews} />
          <MetricCard label="Velocity" value={data.metrics.velocity} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Standup Summary</CardTitle>
            <CardDescription>Auto-generated from git activity</CardDescription>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">Once GitHub is connected, standup summaries will be auto-generated here each morning with per-developer Done / In Progress / Blockers.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Activity Feed</CardTitle>
            <CardDescription>Recent commits, PRs, and reviews</CardDescription>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">A chronological feed of engineering activity across your tracked repos.</p>
          </CardContent>
        </Card>
      </div>
  )
}
