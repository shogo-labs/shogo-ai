import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import SkillViewer from '@/components/SkillViewer'
import {
  listSkills,
  seedSkillsFromManifest,
  STAGE_LABELS,
  type SeedResult,
  type SkillDoc,
  type Stage,
} from '@/lib/vet-api'

// Display order for the core roles — mirrors the 7-stage sprint pipeline.
const STAGE_ORDER: Stage[] = ['think', 'plan', 'build', 'review', 'test', 'ship', 'reflect']

export default function RolesPanel() {
  const [skills, setSkills] = useState<SkillDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<SkillDoc | null>(null)
  const [seeding, setSeeding] = useState(false)
  const [seedMsg, setSeedMsg] = useState<string | null>(null)

  async function refresh() {
    const rows = await listSkills({ core: true })
    setSkills(rows)
    setLoading(false)
  }

  useEffect(() => {
    let cancelled = false
    listSkills({ core: true }).then((rows) => {
      if (cancelled) return
      setSkills(rows)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSeed() {
    setSeeding(true)
    setSeedMsg(null)
    try {
      const r: SeedResult = await seedSkillsFromManifest()
      setSeedMsg(
        `Seeded ${r.created} skill${r.created === 1 ? '' : 's'}` +
          (r.skipped ? `, skipped ${r.skipped} already present` : '') +
          (r.failed ? `, ${r.failed} failed` : '') +
          ` (of ${r.total}).`,
      )
      await refresh()
    } catch (e) {
      setSeedMsg(`Seed failed: ${(e as Error).message}`)
    } finally {
      setSeeding(false)
    }
  }

  const grouped = STAGE_ORDER.map((stage) => ({
    stage,
    label: STAGE_LABELS[stage],
    skills: skills.filter((s) => s.stage === stage),
  }))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Roles</h2>
          <p className="text-sm text-muted-foreground">
            Every role's system prompt is a verbatim port of the corresponding{' '}
            <code className="text-xs">garrytan/gstack</code> SKILL.md.
          </p>
        </div>
        <Badge variant="outline">
          {loading ? 'Loading…' : `${skills.length} core roles`}
        </Badge>
      </div>

      {!loading && skills.length === 0 && (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground space-y-3">
            <p>
              SkillDoc table is empty. Seed it now from the verbatim-ported
              files bundled under{' '}
              <code>.shogo/skills/gstack-&lt;name&gt;/SKILL.md</code>, or run
              the <code>seed-skills</code> skill in chat.
            </p>
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={handleSeed} disabled={seeding}>
                {seeding ? 'Seeding…' : 'Seed skills from manifest'}
              </Button>
              {seedMsg && <span className="text-xs">{seedMsg}</span>}
            </div>
          </CardContent>
        </Card>
      )}

      {!loading && skills.length > 0 && seedMsg && (
        <div className="text-xs text-muted-foreground">{seedMsg}</div>
      )}

      {grouped.map((group) =>
        group.skills.length === 0 ? null : (
          <div key={group.stage}>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              {group.label}
            </h3>
            <div className="grid grid-cols-3 gap-3">
              {group.skills.map((s) => (
                <Card key={s.id}>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <span className="font-mono">{s.name}</span>
                      <Badge variant="outline" className="text-[10px]">{s.role}</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-xs text-muted-foreground line-clamp-3">
                      {s.body.slice(0, 180)}…
                    </p>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setSelected(s)}>
                        View prompt
                      </Button>
                      <a
                        href={s.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-muted-foreground underline"
                      >
                        source
                      </a>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        ),
      )}

      <SkillViewer
        skill={selected}
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
      />
    </div>
  )
}
