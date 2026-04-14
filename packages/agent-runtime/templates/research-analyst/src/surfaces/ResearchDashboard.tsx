import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricCard } from '@/components/MetricCard'
import initialData from './ResearchDashboard.data.json'

export default function ResearchDashboard() {
  const [data] = useState(initialData)

  return (
    <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Research Dashboard</h2>
          <Badge variant="outline">Ready to research</Badge>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <MetricCard label="Tracked Topics" value={data.metrics.topics} />
          <MetricCard label="Sources Indexed" value={data.metrics.sources} />
          <MetricCard label="Last Updated" value={data.metrics.updated} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Active Research</CardTitle>
            <CardDescription>Your research projects</CardDescription>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">{"Tell me a topic to research and I'll search the web, synthesize findings, and build an analysis dashboard. Try: \"Research the latest developments in AI agents\""}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Getting Started</CardTitle>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">I research from 5+ sources, distinguish facts from opinions, and always cite URLs. Ask anything.</p>
          </CardContent>
        </Card>
      </div>
  )
}
