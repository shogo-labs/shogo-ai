import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { listIncomeProjection, type IncomeProjection as IncomeProjectionRecord } from '@/lib/market-api'

export default function IncomeProjection() {
  const [items, setItems] = useState<IncomeProjectionRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const rows = await listIncomeProjection()
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
          <h2 className="text-2xl font-semibold tracking-tight">Income Projection</h2>
          <p className="text-sm text-muted-foreground">Track expected monthly income and gap to target.</p>
        </div>
        <Badge variant="outline">{loading ? 'Loading...' : `${items.length} saved`}</Badge>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No income projection records yet</CardTitle>
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
                <CardTitle className="text-base">Income Projection</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Period:</span> {item.period}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Expected Income:</span> {item.expectedIncome}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Target Income:</span> {item.targetIncome}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Gap:</span> {item.gap}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
