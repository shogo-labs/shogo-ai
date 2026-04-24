import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import SkillViewer from '@/components/SkillViewer'
import { listSkills, type SkillDoc } from '@/lib/vet-api'

export default function SkillsRegistry() {
  const [skills, setSkills] = useState<SkillDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'core' | 'optional'>('all')
  const [selected, setSelected] = useState<SkillDoc | null>(null)

  useEffect(() => {
    let cancelled = false
    listSkills().then((rows) => {
      if (cancelled) return
      setSkills(rows)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return skills
      .filter((s) =>
        filter === 'all' ? true : filter === 'core' ? s.isCore : !s.isCore,
      )
      .filter((s) =>
        q === '' ? true : s.name.includes(q) || s.role.includes(q) || s.body.toLowerCase().includes(q),
      )
  }, [skills, query, filter])

  const coreCount = skills.filter((s) => s.isCore).length

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Skills Registry</h2>
          <p className="text-sm text-muted-foreground">
            All {skills.length} ported gstack skills. {coreCount} are wired into the
            default pipeline; the rest are optional power tools. Every body is a
            byte-identical copy of the upstream SKILL.md at the pinned commit.
          </p>
        </div>
        <Badge variant="outline">
          {loading ? 'Loading…' : `${visible.length} / ${skills.length}`}
        </Badge>
      </div>

      <div className="flex items-center gap-2">
        <Input
          placeholder="Filter by name, role, or body…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-md"
        />
        <div className="flex gap-1">
          {(['all', 'core', 'optional'] as const).map((k) => (
            <Button
              key={k}
              size="sm"
              variant={filter === k ? 'default' : 'outline'}
              onClick={() => setFilter(k)}
            >
              {k}
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="divide-y">
            <div className="grid grid-cols-[1.5fr_1fr_1fr_80px_2fr_80px] gap-3 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground bg-muted/50">
              <span>Name</span>
              <span>Role</span>
              <span>Stage</span>
              <span>Core</span>
              <span>Source</span>
              <span></span>
            </div>
            {visible.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                {loading ? 'Loading…' : 'No skills match.'}
              </div>
            ) : (
              visible.map((s) => (
                <div
                  key={s.id}
                  className="grid grid-cols-[1.5fr_1fr_1fr_80px_2fr_80px] gap-3 px-4 py-3 text-sm items-center hover:bg-muted/30 cursor-pointer"
                  onClick={() => setSelected(s)}
                >
                  <span className="font-mono">{s.name}</span>
                  <span className="text-muted-foreground">{s.role}</span>
                  <span className="text-muted-foreground">{s.stage}</span>
                  <span>{s.isCore ? <Badge>core</Badge> : <span className="text-muted-foreground text-xs">—</span>}</span>
                  <a
                    href={s.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-xs text-muted-foreground underline truncate"
                  >
                    {s.sourceUrl.replace('https://github.com/garrytan/gstack/blob/', '')}
                  </a>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation()
                      setSelected(s)
                    }}
                  >
                    View
                  </Button>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <SkillViewer
        skill={selected}
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
      />
    </div>
  )
}
