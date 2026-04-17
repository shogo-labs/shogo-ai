import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricCard } from '@/components/MetricCard'
import initialData from './HealthDashboard.data.json'

export default function HealthDashboard() {
  const [data] = useState(initialData)

  return (
    <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Health Dashboard</h2>
          <Badge variant="outline">No endpoints configured</Badge>
        </div>
        <div className="grid grid-cols-4 gap-4">
          <MetricCard label="Endpoints" value={data.metrics.endpoints} />
          <MetricCard label="Uptime" value={data.metrics.uptime} />
          <MetricCard label="Avg Latency" value={data.metrics.latency} unit="ms" />
          <MetricCard label="Incidents (24h)" value={data.metrics.incidents} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Service Status</CardTitle>
          </CardHeader>
          <CardContent>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Badge variant="secondary">●</Badge>
              <p>API Server</p>
              <p className="text-sm text-muted-foreground">Not configured</p>
            </div>
            <div className="flex items-center justify-between">
              <Badge variant="secondary">●</Badge>
              <p>Database</p>
              <p className="text-sm text-muted-foreground">Not configured</p>
            </div>
            <div className="flex items-center justify-between">
              <Badge variant="secondary">●</Badge>
              <p>CDN / Frontend</p>
              <p className="text-sm text-muted-foreground">Not configured</p>
            </div>
          </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Getting Started</CardTitle>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">{"Share your API health check URLs and I'll start monitoring every 5 minutes. Say \"Connect Sentry\" for error tracking."}</p>
          </CardContent>
        </Card>
      </div>
  )
}
