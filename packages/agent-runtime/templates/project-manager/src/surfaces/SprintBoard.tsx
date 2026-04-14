import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricCard } from '@/components/MetricCard'
import initialData from './SprintBoard.data.json'

export default function SprintBoard() {
  const [data] = useState(initialData)

  return (
    <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Sprint Board</h2>
          <Badge variant="outline">Ready to set up</Badge>
        </div>
        <div className="grid grid-cols-4 gap-4">
          <MetricCard label="Open Tasks" value={data.metrics.openTasks} />
          <MetricCard label="Velocity" value={data.metrics.velocity} unit="pts" />
          <MetricCard label="Open Bugs" value={data.metrics.bugs} />
          <MetricCard label="Done This Sprint" value={data.metrics.done} />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardHeader>
              <CardTitle>To Do</CardTitle>
            </CardHeader>
            <CardContent>
            <p className="text-sm text-muted-foreground">Tasks will appear here</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>In Progress</CardTitle>
            </CardHeader>
            <CardContent>
            <p className="text-sm text-muted-foreground">Active tasks</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Done</CardTitle>
            </CardHeader>
            <CardContent>
            <p className="text-sm text-muted-foreground">Completed tasks</p>
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Getting Started</CardTitle>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">{"Say \"Connect Linear\" to import tasks, or \"Create a sprint board\" to start tracking tasks directly here."}</p>
          </CardContent>
        </Card>
      </div>
  )
}
