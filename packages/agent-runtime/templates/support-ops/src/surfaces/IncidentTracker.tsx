import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricCard } from '@/components/MetricCard'
import initialData from './IncidentTracker.data.json'

export default function IncidentTracker() {
  const [data] = useState(initialData)

  return (
    <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Incident Tracker</h2>
          <Badge variant="outline">No active incidents</Badge>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <MetricCard label="Active Incidents" value={data.metrics.active} />
          <MetricCard label="Avg MTTR" value={data.metrics.mttr} />
          <MetricCard label="Incidents (30d)" value={data.metrics.total} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Incident History</CardTitle>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">Incidents will be logged here with timelines, affected services, and resolution details.</p>
          </CardContent>
        </Card>
      </div>
  )
}
