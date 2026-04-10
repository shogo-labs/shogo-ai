import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricCard } from '@/components/MetricCard'
import initialData from './SeoDashboard.data.json'

export default function SeoDashboard() {
  const [data] = useState(initialData)

  return (
    <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">SEO Dashboard</h2>
          <Badge variant="outline">Share your site URL to start</Badge>
        </div>
        <div className="grid grid-cols-4 gap-4">
          <MetricCard label="Pages Audited" value={data.metrics.pages} />
          <MetricCard label="Keywords Tracked" value={data.metrics.keywords} />
          <MetricCard label="SEO Score" value={data.metrics.score} />
          <MetricCard label="Issues Found" value={data.metrics.issues} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>SEO Audit</CardTitle>
            <CardDescription>Technical and on-page audit results</CardDescription>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">Share your website URL and I'll run a comprehensive SEO audit covering technical issues, on-page optimization, schema markup, and AI-search readiness.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Getting Started</CardTitle>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">{"Try: \"Audit the SEO on https://example.com\" — I'll analyze technical health, content optimization, and competitive keywords."}</p>
          </CardContent>
        </Card>
      </div>
  )
}
