import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { listActionPlan, type ActionPlan as ActionPlanRecord } from '@/lib/market-api'

export default function ActionPlan() {
  const [items, setItems] = useState<ActionPlanRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const rows = await listActionPlan()
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
          <h2 className="text-2xl font-semibold tracking-tight">Action Plan</h2>
          <p className="text-sm text-muted-foreground">Maintain recommended actions, timing, and confidence.</p>
        </div>
        <Badge variant="outline">{loading ? 'Loading...' : `${items.length} saved`}</Badge>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No action plan records yet</CardTitle>
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
                <CardTitle className="text-base">Action Plan</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Action:</span> {item.action}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Trigger:</span> {item.trigger}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Timeframe:</span> {item.timeframe}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Owner:</span> {item.owner}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
