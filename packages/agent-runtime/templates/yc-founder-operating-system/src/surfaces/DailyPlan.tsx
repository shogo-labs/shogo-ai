import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricCard } from '@/components/MetricCard'
import initialData from './DailyPlan.data.json'

interface Priority {
  title: string
  outcome: string
  estimate: string
}

interface DeepWorkBlock {
  start: string
  end: string
  task: string
}

interface MeetingPrep {
  title: string
  when: string
  prep: string
}

export default function DailyPlan() {
  const [data] = useState(initialData)
  const priorities = data.priorities as Priority[]
  const deepWork = data.deepWorkBlocks as DeepWorkBlock[]
  const meetings = data.meetingPrep as MeetingPrep[]

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">Daily Plan</h2>
        <Badge variant="outline">Awaiting morning auto-plan</Badge>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <MetricCard label="Focus Hours" value={data.metrics.focusHours} />
        <MetricCard label="Meetings Today" value={data.metrics.meetings} />
        <MetricCard label="Open Decisions" value={data.metrics.openDecisions} />
        <MetricCard label="Slipped Yesterday" value={data.metrics.slippedYesterday} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Top 3 Priorities</CardTitle>
        </CardHeader>
        <CardContent>
          {priorities.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {"Say \"Plan my day\" to run the auto-plan skill and generate your top 3."}
            </p>
          ) : (
            <ol className="space-y-3">
              {priorities.map((p, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span className="text-lg font-bold text-muted-foreground">{i + 1}.</span>
                  <div className="flex-1">
                    <p className="font-medium">{p.title}</p>
                    <p className="text-sm text-muted-foreground">
                      {p.outcome} · {p.estimate}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Deep Work Blocks</CardTitle>
          </CardHeader>
          <CardContent>
            {deepWork.length === 0 ? (
              <p className="text-sm text-muted-foreground">No blocks scheduled yet.</p>
            ) : (
              <ul className="space-y-2">
                {deepWork.map((b, i) => (
                  <li key={i} className="flex items-baseline gap-3 text-sm">
                    <span className="font-mono font-semibold">
                      {b.start}–{b.end}
                    </span>
                    <span>{b.task}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Meeting Prep</CardTitle>
          </CardHeader>
          <CardContent>
            {meetings.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing needs prep right now.</p>
            ) : (
              <ul className="space-y-3">
                {meetings.map((m, i) => (
                  <li key={i}>
                    <p className="text-sm font-medium">
                      {m.title} <span className="text-muted-foreground">· {m.when}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">{m.prep}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
