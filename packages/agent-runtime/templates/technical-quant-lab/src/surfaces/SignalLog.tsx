import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { listPatternSignal, type PatternSignal as PatternSignalRecord } from '@/lib/market-api'

export default function SignalLog() {
  const [items, setItems] = useState<PatternSignalRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const rows = await listPatternSignal()
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
          <h2 className="text-2xl font-semibold tracking-tight">Signal Log</h2>
          <p className="text-sm text-muted-foreground">Track technical and quantitative signals with evidence and confidence.</p>
        </div>
        <Badge variant="outline">{loading ? 'Loading...' : `${items.length} saved`}</Badge>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No pattern signal records yet</CardTitle>
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
                <CardTitle className="text-base">Pattern Signal</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Ticker:</span> {item.ticker}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Pattern:</span> {item.pattern}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Signal Type:</span> {item.signalType}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Confidence:</span> {item.confidence}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
