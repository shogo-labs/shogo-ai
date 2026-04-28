import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { listEventPattern, type EventPattern as EventPatternRecord } from '@/lib/market-api'

export default function QuantPatternFinder() {
  const [items, setItems] = useState<EventPatternRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const rows = await listEventPattern()
      if (cancelled) return
      setItems(rows)
      setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Quant Pattern Finder</h2>
          <p className="text-sm text-muted-foreground">Catalog seasonal, event, earnings, and institutional patterns.</p>
        </div>
        <Badge variant="outline">{loading ? 'Loading...' : `${items.length} saved`}</Badge>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No event pattern records yet</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Ask the agent to run the matching workflow. It will persist structured results through the Prisma-backed API.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((item) => (
            <Card key={item.id}>
              <CardHeader>
                <CardTitle className="text-base">Event Pattern</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Ticker:</span> {item.ticker}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Event Type:</span> {item.eventType}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Period:</span> {item.period}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Historical Behavior:</span> {item.historicalBehavior}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
