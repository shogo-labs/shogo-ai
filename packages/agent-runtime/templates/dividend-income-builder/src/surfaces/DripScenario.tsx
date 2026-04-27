import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { listReinvestmentScenario, type ReinvestmentScenario as ReinvestmentScenarioRecord } from '@/lib/market-api'

export default function DripScenario() {
  const [items, setItems] = useState<ReinvestmentScenarioRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const rows = await listReinvestmentScenario()
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
          <h2 className="text-2xl font-semibold tracking-tight">Drip Scenario</h2>
          <p className="text-sm text-muted-foreground">Compare reinvestment assumptions and compounding paths.</p>
        </div>
        <Badge variant="outline">{loading ? 'Loading...' : `${items.length} saved`}</Badge>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No reinvestment scenario records yet</CardTitle>
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
                <CardTitle className="text-base">Reinvestment Scenario</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Name:</span> {item.name}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Horizon Years:</span> {item.horizonYears}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Starting Capital:</span> {item.startingCapital}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Assumed Growth:</span> {item.assumedGrowth}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
