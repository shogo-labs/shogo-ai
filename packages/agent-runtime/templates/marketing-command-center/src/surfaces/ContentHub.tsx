import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricCard } from '@/components/MetricCard'
import initialData from './ContentHub.data.json'

export default function ContentHub() {
  const [data] = useState(initialData)

  return (
    <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Content Hub</h2>
          <Badge variant="outline">Ready to create</Badge>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <MetricCard label="Drafts" value={data.metrics.drafts} />
          <MetricCard label="Published" value={data.metrics.published} />
          <MetricCard label="Scheduled" value={data.metrics.scheduled} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Content Calendar</CardTitle>
            <CardDescription>Upcoming posts and emails</CardDescription>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">Your content calendar will track blog posts, social content, email campaigns, and newsletter editions all in one place.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Recent Drafts</CardTitle>
            <CardDescription>Copy, emails, and social posts</CardDescription>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">{"Ask me to write anything: \"Draft a homepage headline\" or \"Write a 5-email welcome sequence\" — drafts appear here for review."}</p>
          </CardContent>
        </Card>
      </div>
  )
}
