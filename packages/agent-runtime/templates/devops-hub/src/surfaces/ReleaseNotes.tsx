import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricCard } from '@/components/MetricCard'
import initialData from './ReleaseNotes.data.json'

export default function ReleaseNotes() {
  const [data] = useState(initialData)

  return (
    <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Release Notes</h2>
          <Badge variant="outline">No repos connected</Badge>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <MetricCard label="Unreleased PRs" value={data.metrics.unreleased} />
          <MetricCard label="Days Since Release" value={data.metrics.daysSince} />
          <MetricCard label="Deploy Status" value={data.metrics.deployStatus} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Unreleased Changes</CardTitle>
            <CardDescription>PRs merged since last release</CardDescription>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">I'll automatically track merged PRs and generate changelogs grouped by Features, Fixes, and Breaking Changes.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Deployment Checklist</CardTitle>
            <CardDescription>Pre-release steps</CardDescription>
          </CardHeader>
          <CardContent>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Badge variant="secondary">1</Badge>
              <p>Review changelog and breaking changes</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">2</Badge>
              <p>Verify CI pipeline is green</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">3</Badge>
              <p>Tag release and notify stakeholders</p>
            </div>
          </div>
          </CardContent>
        </Card>
      </div>
  )
}
