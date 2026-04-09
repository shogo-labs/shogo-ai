import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricCard } from '@/components/MetricCard'
import initialData from './StandupSummary.data.json'

export default function StandupSummary() {
  const [data] = useState(initialData)

  return (
    <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Standup Summary</h2>
          <Badge variant="outline">Not yet generated</Badge>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <MetricCard label="Team Active" value={data.metrics.teamActive} />
          <MetricCard label="Blockers" value={data.metrics.blockers} />
          <MetricCard label="Items in Flight" value={data.metrics.inFlight} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Today's Summary</CardTitle>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">Standup summaries will be generated here each morning from task activity and team updates.</p>
          </CardContent>
        </Card>
      </div>
  )
}
