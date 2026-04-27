import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { listEarningsNote, type EarningsNote as EarningsNoteRecord } from '@/lib/market-api'

export default function EarningsNotes() {
  const [items, setItems] = useState<EarningsNoteRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const rows = await listEarningsNote()
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
          <h2 className="text-2xl font-semibold tracking-tight">Earnings Notes</h2>
          <p className="text-sm text-muted-foreground">Archive earnings takeaways, source links, and follow-up questions.</p>
        </div>
        <Badge variant="outline">{loading ? 'Loading...' : `${items.length} saved`}</Badge>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No earnings note records yet</CardTitle>
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
                <CardTitle className="text-base">Earnings Note</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Ticker:</span> {item.ticker}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Period:</span> {item.period}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Headline:</span> {item.headline}</p>
              <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">Takeaways:</span> {item.takeaways}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
