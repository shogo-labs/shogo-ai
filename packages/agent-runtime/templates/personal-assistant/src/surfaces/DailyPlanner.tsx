import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricCard } from '@/components/MetricCard'
import initialData from './DailyPlanner.data.json'

export default function DailyPlanner() {
  const [data] = useState(initialData)

  return (
    <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Daily Planner</h2>
          <Badge variant="outline">Ready to set up</Badge>
        </div>
        <div className="grid grid-cols-4 gap-4">
          <MetricCard label="Meetings Today" value={data.metrics.meetings} />
          <MetricCard label="Open Tasks" value={data.metrics.tasks} />
          <MetricCard label="Reminders" value={data.metrics.reminders} />
          <MetricCard label="Habit Streak" value={data.metrics.streak} unit="days" />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Today's Schedule</CardTitle>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">{"Connect your calendar and I'll show today's meetings with prep notes. Say \"Connect Google Calendar\" to start."}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Getting Started</CardTitle>
          </CardHeader>
          <CardContent>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">Set up your personal hub:</p>
            <div className="flex flex-col gap-2">
              <p>{"• \"Connect my Google Calendar\" for daily schedule"}</p>
              <p>{"• \"Track exercise and reading habits\" for habit tracking"}</p>
              <p>{"• \"Remind me to...\" for reminders and tasks"}</p>
            </div>
          </div>
          </CardContent>
        </Card>
      </div>
  )
}
