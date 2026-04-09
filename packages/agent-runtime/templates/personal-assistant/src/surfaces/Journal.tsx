import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricCard } from '@/components/MetricCard'
import initialData from './Journal.data.json'

export default function Journal() {
  const [data] = useState(initialData)

  return (
    <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Journal</h2>
          <Badge variant="outline">Start your first entry</Badge>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <MetricCard label="Streak" value={data.metrics.streak} unit="days" />
          <MetricCard label="Entries" value={data.metrics.entries} />
          <MetricCard label="Avg Mood" value={data.metrics.mood} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Today's Reflection</CardTitle>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">Just tell me how your day went — I'll track mood, gratitude, and themes over time.</p>
          </CardContent>
        </Card>
      </div>
  )
}
