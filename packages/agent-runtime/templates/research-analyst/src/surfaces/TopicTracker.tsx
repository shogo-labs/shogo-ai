import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricCard } from '@/components/MetricCard'
import initialData from './TopicTracker.data.json'

export default function TopicTracker() {
  const [data] = useState(initialData)

  return (
    <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Topic Tracker</h2>
          <Badge variant="outline">No topics tracked yet</Badge>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <MetricCard label="Topics Tracked" value={data.metrics.tracked} />
          <MetricCard label="New Today" value={data.metrics.newToday} />
          <MetricCard label="Alerts" value={data.metrics.alerts} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Monitored Topics</CardTitle>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">{"Say \"Track AI agents\" or \"Monitor quantum computing news\" — I'll check for developments on every heartbeat and alert you."}</p>
          </CardContent>
        </Card>
      </div>
  )
}
