import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { listDividendSafetyCheck, type DividendSafetyCheck as DividendSafetyCheckRecord } from '@/lib/market-api'

export default function SafetyScores() {
  const [items, setItems] = useState<DividendSafetyCheckRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const rows = await listDividendSafetyCheck()
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
          <h2 className="text-2xl font-semibold tracking-tight">Safety Scores</h2>
          <p className="text-sm text-muted-foreground">Review payout ratio, debt, coverage, and cut-risk notes.</p>
        </div>
        <Badge variant="outline">{loading ? 'Loading...' : `${items.length} saved`}</Badge>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No dividend safety check records yet</CardTitle>
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
                <CardTitle className="text-base">Dividend Safety Check</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Ticker:</span> {item.ticker}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Payout Ratio:</span> {item.payoutRatio}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Debt Note:</span> {item.debtNote}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Coverage Note:</span> {item.coverageNote}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
