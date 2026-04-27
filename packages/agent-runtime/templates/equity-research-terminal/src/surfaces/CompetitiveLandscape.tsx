import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { listCompetitiveSet, type CompetitiveSet as CompetitiveSetRecord } from '@/lib/market-api'

export default function CompetitiveLandscape() {
  const [items, setItems] = useState<CompetitiveSetRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const rows = await listCompetitiveSet()
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
          <h2 className="text-2xl font-semibold tracking-tight">Competitive Landscape</h2>
          <p className="text-sm text-muted-foreground">Compare peer groups, moat ratings, threats, and catalysts.</p>
        </div>
        <Badge variant="outline">{loading ? 'Loading...' : `${items.length} saved`}</Badge>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No competitive set records yet</CardTitle>
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
                <CardTitle className="text-base">Competitive Set</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Sector:</span> {item.sector}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Leader Ticker:</span> {item.leaderTicker}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Peer Tickers:</span> {item.peerTickers}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Moat Summary:</span> {item.moatSummary}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
