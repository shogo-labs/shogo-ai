/**
 * AgentSkillsPanel
 *
 * Browse, create, and manage agent skills.
 * Includes a library of bundled skills that can be installed with one click.
 * Skills are Markdown files with YAML frontmatter in the agent's skills/ directory.
 */

import { useState, useEffect, useCallback } from 'react'
import { Zap, Plus, RefreshCw, BookOpen, Download, Check, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAgentUrl } from '@/hooks/useAgentUrl'

interface Skill {
  file: string
  name: string
  description: string
  trigger: string
}

interface BundledSkill {
  name: string
  description: string
  trigger: string
  tools: string[]
}

interface AgentSkillsPanelProps {
  projectId: string
  visible: boolean
  localAgentUrl?: string | null
}

export function AgentSkillsPanel({ projectId, visible, localAgentUrl }: AgentSkillsPanelProps) {
  const [skills, setSkills] = useState<Skill[]>([])
  const [bundledSkills, setBundledSkills] = useState<BundledSkill[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showLibrary, setShowLibrary] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const { refetch: getAgentUrl } = useAgentUrl(projectId, localAgentUrl)

  const loadSkills = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const baseUrl = await getAgentUrl()

      const [statusRes, bundledRes] = await Promise.all([
        fetch(`${baseUrl}/agent/status`),
        fetch(`${baseUrl}/agent/bundled-skills`),
      ])

      if (!statusRes.ok) throw new Error('Agent not reachable')
      const status = await statusRes.json()

      setSkills(
        (status.skills || []).map((s: any) => ({
          file: `${s.name}.md`,
          name: s.name,
          description: s.description || '',
          trigger: s.trigger || '',
        }))
      )

      if (bundledRes.ok) {
        const bundledData = await bundledRes.json()
        setBundledSkills(bundledData.skills || [])
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }, [getAgentUrl])

  useEffect(() => {
    if (visible) loadSkills()
  }, [visible, loadSkills])

  const handleInstall = useCallback(async (skillName: string) => {
    setInstalling(skillName)
    try {
      const baseUrl = await getAgentUrl()
      const res = await fetch(`${baseUrl}/agent/bundled-skills/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: skillName }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to install skill')
      }

      await loadSkills()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setInstalling(null)
    }
  }, [getAgentUrl, loadSkills])

  const handleRemove = useCallback(async (skillName: string) => {
    setRemoving(skillName)
    try {
      const baseUrl = await getAgentUrl()
      const res = await fetch(`${baseUrl}/agent/skills/${encodeURIComponent(skillName)}`, {
        method: 'DELETE',
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to remove skill')
      }

      await loadSkills()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setRemoving(null)
    }
  }, [getAgentUrl, loadSkills])

  const installedNames = new Set(skills.map((s) => s.name))
  const availableBundled = bundledSkills.filter((s) => !installedNames.has(s.name))

  return (
    <div className={cn('absolute inset-0 flex flex-col', !visible && 'invisible pointer-events-none')}>
      <div className="px-4 py-3 border-b flex items-center gap-2">
        <Zap className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Skills</span>
        <span className="text-xs text-muted-foreground">
          {skills.length} installed
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setShowLibrary(!showLibrary)}
            className={cn(
              'flex items-center gap-1 px-2 py-1 rounded text-xs',
              showLibrary
                ? 'bg-primary text-primary-foreground'
                : 'hover:bg-muted text-muted-foreground'
            )}
            title="Browse skill library"
          >
            <BookOpen className="h-3 w-3" />
            Library
          </button>
          <button
            onClick={loadSkills}
            className="p-1 rounded hover:bg-muted text-muted-foreground"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 bg-destructive/10 text-destructive text-xs">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="text-sm text-muted-foreground text-center py-8">Loading skills...</div>
        ) : showLibrary ? (
          /* Bundled Skills Library */
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Pre-built skills you can add to your agent with one click.
              </p>
            </div>

            {availableBundled.length === 0 && bundledSkills.length > 0 ? (
              <div className="text-center py-8">
                <Check className="h-8 w-8 text-green-500 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">All bundled skills are installed!</p>
              </div>
            ) : availableBundled.length === 0 ? (
              <div className="text-center py-8">
                <BookOpen className="h-8 w-8 text-muted-foreground/50 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">No bundled skills available</p>
              </div>
            ) : (
              availableBundled.map((skill) => (
                <div
                  key={skill.name}
                  className="border rounded-lg p-3 hover:bg-muted/30 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">{skill.name}</div>
                      {skill.description && (
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {skill.description}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => handleInstall(skill.name)}
                      disabled={installing === skill.name}
                      className={cn(
                        'shrink-0 flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors',
                        installing === skill.name
                          ? 'bg-muted text-muted-foreground'
                          : 'bg-primary text-primary-foreground hover:bg-primary/90'
                      )}
                    >
                      <Download className="h-3 w-3" />
                      {installing === skill.name ? 'Installing...' : 'Install'}
                    </button>
                  </div>
                  {skill.trigger && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {skill.trigger.split('|').map((t, i) => (
                        <span
                          key={i}
                          className="inline-block px-1.5 py-0.5 bg-primary/10 text-primary text-[10px] rounded"
                        >
                          {t.trim()}
                        </span>
                      ))}
                    </div>
                  )}
                  {skill.tools && skill.tools.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {skill.tools.map((tool) => (
                        <span
                          key={tool}
                          className="inline-block px-1.5 py-0.5 bg-muted text-[10px] rounded text-muted-foreground"
                        >
                          {tool}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}

            {/* Also show already installed bundled skills */}
            {bundledSkills.filter((s) => installedNames.has(s.name)).length > 0 && (
              <div className="mt-4">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                  Already Installed
                </div>
                {bundledSkills
                  .filter((s) => installedNames.has(s.name))
                  .map((skill) => (
                    <div
                      key={skill.name}
                      className="border border-dashed rounded-lg p-3 mb-2 opacity-60"
                    >
                      <div className="flex items-center gap-2">
                        <Check className="h-3.5 w-3.5 text-green-500" />
                        <span className="text-sm font-medium">{skill.name}</span>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        ) : skills.length === 0 ? (
          /* Empty state */
          <div className="text-center py-12">
            <Zap className="h-8 w-8 text-muted-foreground/50 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground mb-1">No skills installed</p>
            <p className="text-xs text-muted-foreground/70 mb-3">
              Skills teach your agent specific behaviors triggered by keywords.
            </p>
            <button
              onClick={() => setShowLibrary(true)}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-xs bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <BookOpen className="h-3 w-3" />
              Browse Skill Library
            </button>
          </div>
        ) : (
          /* Installed skills list */
          <div className="space-y-3">
            {skills.map((skill) => (
              <div
                key={skill.file}
                className="border rounded-lg p-3 hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{skill.name}</div>
                    {skill.description && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {skill.description}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => handleRemove(skill.name)}
                    disabled={removing === skill.name}
                    className={cn(
                      'shrink-0 p-1 rounded transition-colors',
                      removing === skill.name
                        ? 'text-muted-foreground'
                        : 'text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10'
                    )}
                    title="Remove skill"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {skill.trigger && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {skill.trigger.split('|').map((t, i) => (
                      <span
                        key={i}
                        className="inline-block px-1.5 py-0.5 bg-primary/10 text-primary text-[10px] rounded"
                      >
                        {t.trim()}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {availableBundled.length > 0 && (
              <div className="pt-2 border-t">
                <button
                  onClick={() => setShowLibrary(true)}
                  className="w-full flex items-center justify-center gap-1 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Plus className="h-3 w-3" />
                  {availableBundled.length} more skills available in library
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
