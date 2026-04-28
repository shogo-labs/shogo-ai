import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { listCorrelationObservation, type CorrelationObservation as CorrelationObservationRecord } from '@/lib/market-api'

export default function StressTests() {
  const [items, setItems] = useState<CorrelationObservationRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const rows = await listCorrelationObservation()
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
          <h2 className="text-2xl font-semibold tracking-tight">Stress Tests</h2>
          <p className="text-sm text-muted-foreground">Track correlation and drawdown observations across holdings.</p>
        </div>
        <Badge variant="outline">{loading ? 'Loading...' : `${items.length} saved`}</Badge>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No correlation observation records yet</CardTitle>
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
                <CardTitle className="text-base">Correlation Observation</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Holding A:</span> {item.holdingA}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Holding B:</span> {item.holdingB}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Correlation:</span> {item.correlation}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Period:</span> {item.period}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
