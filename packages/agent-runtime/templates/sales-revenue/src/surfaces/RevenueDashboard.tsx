import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricCard } from '@/components/MetricCard'
import initialData from './RevenueDashboard.data.json'

export default function RevenueDashboard() {
  const [data] = useState(initialData)

  return (
    <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Revenue Dashboard</h2>
          <Badge variant="outline">Connect Stripe to start</Badge>
        </div>
        <div className="grid grid-cols-4 gap-4">
          <MetricCard label="MRR" value={data.metrics.mrr} unit="$" />
          <MetricCard label="Balance" value={data.metrics.balance} unit="$" />
          <MetricCard label="Pending" value={data.metrics.pending} />
          <MetricCard label="Customers" value={data.metrics.customers} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Payment Activity</CardTitle>
          </CardHeader>
          <CardContent>
          <p className="text-sm text-muted-foreground">{"Say \"Connect Stripe\" and I'll pull live revenue data with trend charts and failed payment alerts."}</p>
          </CardContent>
        </Card>
      </div>
  )
}
