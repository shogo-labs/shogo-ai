import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { listDividendCandidate, type DividendCandidate as DividendCandidateRecord } from '@/lib/market-api'

export default function DividendBlueprint() {
  const [items, setItems] = useState<DividendCandidateRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const rows = await listDividendCandidate()
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
          <h2 className="text-2xl font-semibold tracking-tight">Dividend Blueprint</h2>
          <p className="text-sm text-muted-foreground">Rank dividend candidates by yield, safety, growth, and sector.</p>
        </div>
        <Badge variant="outline">{loading ? 'Loading...' : `${items.length} saved`}</Badge>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No dividend candidate records yet</CardTitle>
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
                <CardTitle className="text-base">Dividend Candidate</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Ticker:</span> {item.ticker}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Company:</span> {item.company}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Sector:</span> {item.sector}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Yield Text:</span> {item.yieldText}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
