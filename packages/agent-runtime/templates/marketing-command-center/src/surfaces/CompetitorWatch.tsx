import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricCard } from '@/components/MetricCard'
import initialData from './CompetitorWatch.data.json'

export default function CompetitorWatch() {
  const [data] = useState(initialData)

  return (
    <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Competitor Watch</h2>
          <Badge variant="outline">Add competitors to start</Badge>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <MetricCard label="Competitors" value={data.metrics.tracked} />
          <MetricCard label="Changes (7d)" value={data.metrics.changes} />
          <MetricCard label="Alerts" value={data.metrics.alerts} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Comparison Grid</CardTitle>
            <CardDescription>Features, pricing, and positioning</CardDescription>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">Tell me your competitors and I'll build a side-by-side comparison of features, pricing, and messaging that stays current.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Change Log</CardTitle>
            <CardDescription>Detected changes across competitors</CardDescription>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">I'll monitor competitor websites and log pricing, feature, and messaging changes automatically.</p>
          </CardContent>
        </Card>
      </div>
  )
}
