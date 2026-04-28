import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { listPortfolioImpact, type PortfolioImpact as PortfolioImpactRecord } from '@/lib/market-api'

export default function PortfolioImpact() {
  const [items, setItems] = useState<PortfolioImpactRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const rows = await listPortfolioImpact()
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
          <h2 className="text-2xl font-semibold tracking-tight">Portfolio Impact</h2>
          <p className="text-sm text-muted-foreground">Connect macro drivers to holdings and risk notes.</p>
        </div>
        <Badge variant="outline">{loading ? 'Loading...' : `${items.length} saved`}</Badge>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No portfolio impact records yet</CardTitle>
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
                <CardTitle className="text-base">Portfolio Impact</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Holding Or Sector:</span> {item.holdingOrSector}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Macro Driver:</span> {item.macroDriver}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Impact:</span> {item.impact}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Action:</span> {item.action}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
