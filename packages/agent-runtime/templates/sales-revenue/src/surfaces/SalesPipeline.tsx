import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricCard } from '@/components/MetricCard'
import initialData from './SalesPipeline.data.json'

export default function SalesPipeline() {
  const [data] = useState(initialData)

  return (
    <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Sales Pipeline</h2>
          <Badge variant="outline">Ready to set up</Badge>
        </div>
        <div className="grid grid-cols-4 gap-4">
          <MetricCard label="Pipeline Value" value={data.metrics.value} unit="$" />
          <MetricCard label="Active Deals" value={data.metrics.deals} />
          <MetricCard label="Win Rate" value={data.metrics.conversion} />
          <MetricCard label="Avg Deal Size" value={data.metrics.avgDeal} unit="$" />
        </div>
        <div className="grid grid-cols-5 gap-4">
          <Card>
            <CardHeader>
              <CardTitle>New</CardTitle>
            </CardHeader>
            <CardContent>
            <p className="text-sm text-muted-foreground">New leads</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Qualified</CardTitle>
            </CardHeader>
            <CardContent>
            <p className="text-sm text-muted-foreground">Qualified leads</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Proposal</CardTitle>
            </CardHeader>
            <CardContent>
            <p className="text-sm text-muted-foreground">Proposals sent</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Negotiation</CardTitle>
            </CardHeader>
            <CardContent>
            <p className="text-sm text-muted-foreground">In negotiation</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Won</CardTitle>
            </CardHeader>
            <CardContent>
            <p className="text-sm text-muted-foreground">Closed deals</p>
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Getting Started</CardTitle>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">Tell me about your sales process and I'll set up a pipeline with deal tracking and revenue forecasting.</p>
          </CardContent>
        </Card>
      </div>
  )
}
