import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricCard } from '@/components/MetricCard'
import initialData from './AlertFeed.data.json'

export default function AlertFeed() {
  const [data] = useState(initialData)

  return (
    <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Alert Feed</h2>
          <Badge variant="outline">No alerts yet</Badge>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <MetricCard label="Alerts Today" value={data.metrics.alertsToday} />
          <MetricCard label="Unresolved" value={data.metrics.unresolved} />
          <MetricCard label="Keywords Watched" value={data.metrics.keywords} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Recent Alerts</CardTitle>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">Health check failures, Slack keyword matches, and escalations will be logged here chronologically.</p>
          </CardContent>
        </Card>
      </div>
  )
}
