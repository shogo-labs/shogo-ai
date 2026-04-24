import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import ArtifactCard from '@/components/ArtifactCard'
import ArtifactViewer from '@/components/ArtifactViewer'
import {
  listSprints,
  createSprint,
  listArtifactsForSprint,
  advanceSprint,
  artifactsByStage,
  nextStage,
  STAGES,
  STAGE_LABELS,
  STAGE_ROLES,
  type Sprint,
  type Artifact,
  type Stage,
} from '@/lib/vet-api'

export default function SprintBoard() {
  const [sprints, setSprints] = useState<Sprint[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [idea, setIdea] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewer, setViewer] = useState<Artifact | null>(null)

  useEffect(() => {
    let cancelled = false
    listSprints().then((rows) => {
      if (cancelled) return
      setSprints(rows)
      setActiveId(rows[0]?.id ?? null)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!activeId) {
      setArtifacts([])
      return
    }
    let cancelled = false
    listArtifactsForSprint(activeId).then((rows) => {
      if (!cancelled) setArtifacts(rows)
    })
    return () => {
      cancelled = true
    }
  }, [activeId, sprints])

  const activeSprint = useMemo(
    () => sprints.find((s) => s.id === activeId) ?? null,
    [sprints, activeId],
  )
  const byStage = useMemo(() => artifactsByStage(artifacts), [artifacts])

  async function handleCreate() {
    if (!idea.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const created = await createSprint(idea.trim())
      if (!created) {
        setError('Could not create sprint. Check that the skill server is running.')
        return
      }
      setIdea('')
      const rows = await listSprints()
      setSprints(rows)
      setActiveId(created.id)
    } finally {
      setBusy(false)
    }
  }

  async function handleAdvance() {
    if (!activeSprint || busy) return
    const target = nextStage(activeSprint.stage)
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      const updated = await advanceSprint(activeSprint.id, target)
      if (!updated) {
        setError(`Could not advance to ${target}. API error.`)
        return
      }
      const rows = await listSprints()
      setSprints(rows)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Sprint Board</h2>
          <p className="text-sm text-muted-foreground">
            One sprint per idea. The Virtual Engineering Team runs each stage using
            verbatim gstack prompts.
          </p>
        </div>
        <Badge variant="outline">
          {loading ? 'Loading…' : `${sprints.length} sprint${sprints.length === 1 ? '' : 's'}`}
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Start a new sprint</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              placeholder="What are you building?  (e.g. daily briefing app for my calendar)"
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
              }}
              disabled={busy}
            />
            <Button onClick={handleCreate} disabled={busy || !idea.trim()}>
              Start
            </Button>
          </div>
        </CardContent>
      </Card>

      {sprints.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {sprints.map((s) => (
            <Button
              key={s.id}
              size="sm"
              variant={s.id === activeId ? 'default' : 'outline'}
              onClick={() => setActiveId(s.id)}
            >
              <span className="truncate max-w-[180px]">{s.idea}</span>
              <Badge variant="secondary" className="ml-2 text-[10px]">
                {s.stage}
              </Badge>
            </Button>
          ))}
        </div>
      )}

      {error && (
        <div className="border border-red-300 bg-red-50 text-red-900 rounded-md px-4 py-2 text-sm flex items-center justify-between">
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-xs underline"
          >
            dismiss
          </button>
        </div>
      )}

      {activeSprint ? (
        <>
          <div className="flex items-center justify-between border rounded-md px-4 py-3 bg-muted/30">
            <div>
              <p className="text-sm text-muted-foreground">Active sprint</p>
              <p className="text-base font-medium">{activeSprint.idea}</p>
            </div>
            <div className="flex items-center gap-3">
              <Badge>{STAGE_LABELS[activeSprint.stage]}</Badge>
              <Button
                size="sm"
                onClick={handleAdvance}
                disabled={busy || !nextStage(activeSprint.stage)}
              >
                {busy && nextStage(activeSprint.stage)
                  ? 'Advancing…'
                  : nextStage(activeSprint.stage)
                    ? `Advance → ${STAGE_LABELS[nextStage(activeSprint.stage)!]}`
                    : 'Complete'}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-3">
            {STAGES.map((stage) => {
              const isCurrent = activeSprint.stage === stage
              const items = byStage[stage]
              return (
                <div key={stage} className="flex flex-col gap-2">
                  <div
                    className={`text-xs font-semibold uppercase tracking-wider px-2 py-1 rounded ${
                      isCurrent ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {STAGE_LABELS[stage]}
                  </div>
                  <div className="text-[10px] text-muted-foreground px-2">
                    {STAGE_ROLES[stage].join(' · ')}
                  </div>
                  <div className="flex flex-col gap-2 min-h-[120px]">
                    {items.length === 0 ? (
                      <div className="text-[11px] text-muted-foreground italic px-2 py-3 border border-dashed rounded">
                        {isCurrent ? 'awaiting role output' : 'idle'}
                      </div>
                    ) : (
                      items.map((a) => (
                        <ArtifactCard key={a.id} artifact={a} onClick={() => setViewer(a)} />
                      ))
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      ) : (
        !loading && (
          <Card>
            <CardContent className="p-6">
              <p className="text-sm text-muted-foreground">
                No sprints yet. Type an idea above and click Start — the Host role
                (verbatim <code>gstack/office-hours/SKILL.md</code>) will kick off the Think
                stage on the next heartbeat.
              </p>
            </CardContent>
          </Card>
        )
      )}

      <ArtifactViewer
        artifact={viewer}
        open={viewer !== null}
        onOpenChange={(open) => !open && setViewer(null)}
      />
    </div>
  )
}
