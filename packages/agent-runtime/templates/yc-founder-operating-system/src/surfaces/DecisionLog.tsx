import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { listDecisions, type Decision } from '@/lib/founder-api'

export default function DecisionLog() {
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    listDecisions().then((rows) => {
      if (cancelled) return
      setDecisions(rows)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">Decision Log</h2>
        <Badge variant="outline">
          {loading ? 'Loading…' : `${decisions.length} decisions`}
        </Badge>
      </div>

      {decisions.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {loading ? 'Loading decisions…' : 'No decisions logged yet'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {'Every call that comes out of chat, a review, or a meeting will be captured here with reasoning, owner, and reversibility.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {decisions.map((d) => (
            <Card key={d.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{d.decision}</CardTitle>
                  <Badge variant={d.reversibility === 'one-way' ? 'destructive' : 'secondary'}>
                    {d.reversibility === 'one-way' ? 'One-way door' : 'Two-way door'}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                {d.reasoning.length > 0 && (
                  <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
                    {d.reasoning.map((r, j) => (
                      <li key={j}>{r}</li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground mt-3">
                  {new Date(d.at).toLocaleDateString()} · Owner: {d.owner}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
