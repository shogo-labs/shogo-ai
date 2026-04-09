import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricCard } from '@/components/MetricCard'
import initialData from './HiringPipeline.data.json'

export default function HiringPipeline() {
  const [data] = useState(initialData)

  return (
    <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Hiring Pipeline</h2>
          <Badge variant="outline">Ready to set up</Badge>
        </div>
        <div className="grid grid-cols-4 gap-4">
          <MetricCard label="Active Candidates" value={data.metrics.candidates} />
          <MetricCard label="Open Roles" value={data.metrics.roles} />
          <MetricCard label="Avg Time-to-Hire" value={data.metrics.timeToHire} unit="days" />
          <MetricCard label="Offer Rate" value={data.metrics.offerRate} />
        </div>
        <div className="grid grid-cols-5 gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Applied</CardTitle>
            </CardHeader>
            <CardContent>
            <p className="text-sm text-muted-foreground">New applicants</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Screen</CardTitle>
            </CardHeader>
            <CardContent>
            <p className="text-sm text-muted-foreground">Phone screen</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Interview</CardTitle>
            </CardHeader>
            <CardContent>
            <p className="text-sm text-muted-foreground">Interviewing</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Offer</CardTitle>
            </CardHeader>
            <CardContent>
            <p className="text-sm text-muted-foreground">Offer sent</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Hired</CardTitle>
            </CardHeader>
            <CardContent>
            <p className="text-sm text-muted-foreground">Welcome!</p>
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Getting Started</CardTitle>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">Tell me your open roles and I'll set up candidate tracking, interview scheduling, and hiring metrics.</p>
          </CardContent>
        </Card>
      </div>
  )
}
