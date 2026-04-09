import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricCard } from '@/components/MetricCard'
import initialData from './TicketQueue.data.json'

export default function TicketQueue() {
  const [data] = useState(initialData)

  return (
    <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Ticket Queue</h2>
          <Badge variant="outline">Connect ticketing tool</Badge>
        </div>
        <div className="grid grid-cols-4 gap-4">
          <MetricCard label="Open" value={data.metrics.open} />
          <MetricCard label="Resolved (7d)" value={data.metrics.resolved} />
          <MetricCard label="Avg Response" value={data.metrics.responseTime} />
          <MetricCard label="CSAT" value={data.metrics.csat} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Tickets by Priority</CardTitle>
          </CardHeader>
          <CardContent>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Badge variant="destructive">P0 Critical</Badge>
              <p className="text-sm text-muted-foreground">Immediate alert + escalation</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="default">P1 High</Badge>
              <p className="text-sm text-muted-foreground">Alert within 15 minutes</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">P2 Medium</Badge>
              <p className="text-sm text-muted-foreground">Included in daily digest</p>
            </div>
          </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Getting Started</CardTitle>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">{"Say \"Connect Zendesk\" or \"Connect Linear\" — I'll pull tickets, auto-triage, and build SLA tracking."}</p>
          </CardContent>
        </Card>
      </div>
  )
}
