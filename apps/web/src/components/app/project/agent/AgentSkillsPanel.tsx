/**
 * AgentSkillsPanel
 *
 * Browse, create, and manage agent skills.
 * Skills are Markdown files with YAML frontmatter in the agent's skills/ directory.
 */

import { useState, useEffect, useCallback } from 'react'
import { Zap, Plus, Trash2, RefreshCw, Edit } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAgentUrl } from '@/hooks/useAgentUrl'

interface Skill {
  file: string
  name: string
  description: string
  trigger: string
}

interface AgentSkillsPanelProps {
  projectId: string
  visible: boolean
  localAgentUrl?: string | null
}

export function AgentSkillsPanel({ projectId, visible, localAgentUrl }: AgentSkillsPanelProps) {
  const [skills, setSkills] = useState<Skill[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { refetch: getAgentUrl } = useAgentUrl(projectId, localAgentUrl)

  const loadSkills = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const baseUrl = await getAgentUrl()

      const res = await fetch(`${baseUrl}/agent/status`)
      if (!res.ok) throw new Error('Agent not reachable')
      const status = await res.json()

      setSkills(
        (status.skills || []).map((s: any) => ({
          file: `${s.name}.md`,
          name: s.name,
          description: s.description || '',
          trigger: s.trigger || '',
        }))
      )
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }, [getAgentUrl])

  useEffect(() => {
    if (visible) loadSkills()
  }, [visible, loadSkills])

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
        ) : skills.length === 0 ? (
          <div className="text-center py-12">
            <Zap className="h-8 w-8 text-muted-foreground/50 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground mb-1">No skills installed</p>
            <p className="text-xs text-muted-foreground/70">
              Ask the builder AI to create skills for your agent
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {skills.map((skill) => (
              <div
                key={skill.file}
                className="border rounded-lg p-3 hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-sm font-medium">{skill.name}</div>
                    {skill.description && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {skill.description}
                      </div>
                    )}
                  </div>
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
          </div>
        )}
      </div>
    </div>
  )
}
