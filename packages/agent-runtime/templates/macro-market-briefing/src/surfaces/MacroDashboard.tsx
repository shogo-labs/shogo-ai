import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { listMacroIndicator, type MacroIndicator as MacroIndicatorRecord } from '@/lib/market-api'

export default function MacroDashboard() {
  const [items, setItems] = useState<MacroIndicatorRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const rows = await listMacroIndicator()
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
          <h2 className="text-2xl font-semibold tracking-tight">Macro Dashboard</h2>
          <p className="text-sm text-muted-foreground">Track rates, inflation, growth, labor, and currency readings.</p>
        </div>
        <Badge variant="outline">{loading ? 'Loading...' : `${items.length} saved`}</Badge>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No macro indicator records yet</CardTitle>
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
                <CardTitle className="text-base">Macro Indicator</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Name:</span> {item.name}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Latest Reading:</span> {item.latestReading}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Trend:</span> {item.trend}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Source:</span> {item.source}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
