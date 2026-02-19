/**
 * AgentSetupWizard
 *
 * Step-by-step visual wizard for creating/configuring an agent.
 * Alternative to the free-form AI chat builder for users who prefer
 * guided, structured creation.
 *
 * Steps:
 * 1. Choose template or recipe (or start blank)
 * 2. Define personality (name, emoji, tone)
 * 3. Add capabilities (MCP servers, skills)
 * 4. Set schedule (heartbeat, quiet hours)
 * 5. Review and deploy
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  ChevronRight,
  ChevronLeft,
  Check,
  Wand2,
  Server,
  Clock,
  Rocket,
  BookTemplate,
  User,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAgentUrl } from '@/hooks/useAgentUrl'

interface Template {
  id: string
  name: string
  description: string
  category: string
  icon: string
  tags: string[]
  recommendedMCP: string[]
}

interface Recipe {
  id: string
  name: string
  description: string
  category: string
  icon: string
  templateId: string
  mcpServers: string[]
  channel?: string
  heartbeatInterval: number
  requiredCredentials: Array<{ key: string; label: string; description: string; source: string }>
  examplePrompts: string[]
}

interface MCPEntry {
  id: string
  name: string
  description: string
  icon: string
  category: string
  requiredEnv: Record<string, string>
}

interface WizardState {
  step: number
  source: 'blank' | 'template' | 'recipe'
  templateId: string | null
  recipeId: string | null
  agentName: string
  agentEmoji: string
  agentTagline: string
  soulDescription: string
  enabledMCP: string[]
  heartbeatInterval: number
  heartbeatEnabled: boolean
  quietHoursStart: string
  quietHoursEnd: string
}

const STEPS = [
  { id: 'template', label: 'Template', icon: BookTemplate },
  { id: 'personality', label: 'Personality', icon: User },
  { id: 'capabilities', label: 'Capabilities', icon: Server },
  { id: 'schedule', label: 'Schedule', icon: Clock },
  { id: 'review', label: 'Review & Deploy', icon: Rocket },
]

const EMOJI_OPTIONS = ['🤖', '🐙', '🔍', '📚', '💬', '📧', '🎯', '📰', '🕵️', '🐛', '📝', '✅', '📱', '💰', '🏗️', '📋', '📦', '🎓', '💳', '🔴']

interface AgentSetupWizardProps {
  projectId: string
  visible: boolean
  localAgentUrl?: string | null
  onComplete?: () => void
}

export function AgentSetupWizard({ projectId, visible, localAgentUrl, onComplete }: AgentSetupWizardProps) {
  const [state, setState] = useState<WizardState>({
    step: 0,
    source: 'blank',
    templateId: null,
    recipeId: null,
    agentName: '',
    agentEmoji: '🤖',
    agentTagline: '',
    soulDescription: '',
    enabledMCP: [],
    heartbeatInterval: 1800,
    heartbeatEnabled: true,
    quietHoursStart: '23:00',
    quietHoursEnd: '07:00',
  })
  const [templates, setTemplates] = useState<Template[]>([])
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [mcpCatalog, setMCPCatalog] = useState<MCPEntry[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isDeploying, setIsDeploying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { refetch: getAgentUrl } = useAgentUrl(projectId, localAgentUrl)

  useEffect(() => {
    if (!visible) return
    const loadData = async () => {
      try {
        const baseUrl = await getAgentUrl()
        const [tRes, rRes, mRes] = await Promise.all([
          fetch(`${baseUrl}/agent/templates`),
          fetch(`${baseUrl}/agent/recipes`),
          fetch(`${baseUrl}/agent/mcp-catalog`),
        ])
        if (tRes.ok) {
          const d = await tRes.json()
          setTemplates(d.templates || [])
        }
        if (rRes.ok) {
          const d = await rRes.json()
          setRecipes(d.recipes || [])
        }
        if (mRes.ok) {
          const d = await mRes.json()
          setMCPCatalog(d.catalog || [])
        }
      } catch {
        // non-critical — wizard still works without data
      }
    }
    loadData()
  }, [visible, getAgentUrl])

  const update = useCallback((partial: Partial<WizardState>) => {
    setState((prev) => ({ ...prev, ...partial }))
  }, [])

  const selectTemplate = useCallback((t: Template) => {
    update({
      source: 'template',
      templateId: t.id,
      recipeId: null,
      agentName: state.agentName || t.name,
      agentEmoji: t.icon,
      agentTagline: t.description,
      enabledMCP: t.recommendedMCP,
    })
  }, [update, state.agentName])

  const selectRecipe = useCallback((r: Recipe) => {
    const template = templates.find((t) => t.id === r.templateId)
    update({
      source: 'recipe',
      templateId: r.templateId,
      recipeId: r.id,
      agentName: state.agentName || r.name,
      agentEmoji: r.icon,
      agentTagline: r.description,
      enabledMCP: r.mcpServers,
      heartbeatInterval: r.heartbeatInterval,
      heartbeatEnabled: true,
    })
  }, [update, templates, state.agentName])

  const handleDeploy = useCallback(async () => {
    setIsDeploying(true)
    setError(null)
    try {
      const baseUrl = await getAgentUrl()

      if (state.templateId) {
        const copyRes = await fetch(`${baseUrl}/agent/files/config.json`)
        // Apply template via the existing template copy mechanism
        // Write each file directly
        const identityContent = `# Identity\n\n- **Name:** ${state.agentName || 'My Agent'}\n- **Emoji:** ${state.agentEmoji}\n- **Tagline:** ${state.agentTagline || 'My AI agent'}\n`
        await fetch(`${baseUrl}/agent/files/IDENTITY.md`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: identityContent }),
        })
      }

      if (state.soulDescription) {
        const soulContent = `# Soul\n\n${state.soulDescription}\n`
        await fetch(`${baseUrl}/agent/files/SOUL.md`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: soulContent }),
        })
      }

      // Write config
      const config = {
        heartbeatInterval: state.heartbeatInterval,
        heartbeatEnabled: state.heartbeatEnabled,
        quietHours: {
          start: state.quietHoursStart,
          end: state.quietHoursEnd,
          timezone: 'UTC',
        },
        channels: [],
        model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
        mcpServers: {} as Record<string, any>,
      }

      for (const serverId of state.enabledMCP) {
        const entry = mcpCatalog.find((e) => e.id === serverId)
        if (entry) {
          config.mcpServers[serverId] = {
            command: 'npx',
            args: [(entry as any).package || `@anthropic/mcp-${serverId}@latest`],
          }
        }
      }

      await fetch(`${baseUrl}/agent/files/config.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: JSON.stringify(config, null, 2) }),
      })

      onComplete?.()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsDeploying(false)
    }
  }, [state, getAgentUrl, mcpCatalog, onComplete])

  const canProceed = useMemo(() => {
    switch (state.step) {
      case 0: return true
      case 1: return state.agentName.trim().length > 0
      case 2: return true
      case 3: return true
      case 4: return true
      default: return false
    }
  }, [state])

  if (!visible) return null

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      {/* Progress bar */}
      <div className="px-6 py-4 border-b">
        <div className="flex items-center justify-between max-w-2xl mx-auto">
          {STEPS.map((step, i) => {
            const StepIcon = step.icon
            const isActive = i === state.step
            const isDone = i < state.step
            return (
              <div key={step.id} className="flex items-center">
                <button
                  onClick={() => i < state.step && update({ step: i })}
                  className={cn(
                    'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
                    isActive && 'bg-primary text-primary-foreground',
                    isDone && 'bg-primary/10 text-primary cursor-pointer hover:bg-primary/20',
                    !isActive && !isDone && 'text-muted-foreground'
                  )}
                >
                  {isDone ? <Check className="h-3.5 w-3.5" /> : <StepIcon className="h-3.5 w-3.5" />}
                  <span className="hidden sm:inline">{step.label}</span>
                </button>
                {i < STEPS.length - 1 && (
                  <ChevronRight className="h-4 w-4 text-muted-foreground/30 mx-1" />
                )}
              </div>
            )
          })}
        </div>
      </div>

      {error && (
        <div className="px-6 py-2 bg-destructive/10 text-destructive text-xs text-center">{error}</div>
      )}

      {/* Step content */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-2xl mx-auto">
          {/* Step 0: Choose Template/Recipe */}
          {state.step === 0 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold">Choose a starting point</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Start from a recipe, template, or build from scratch.
                </p>
              </div>

              {/* Recipes */}
              {recipes.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
                    <Zap className="h-4 w-4" />
                    Recipes — ready to run
                  </h3>
                  <div className="grid grid-cols-2 gap-3">
                    {recipes.slice(0, 6).map((r) => (
                      <button
                        key={r.id}
                        onClick={() => selectRecipe(r)}
                        className={cn(
                          'text-left border rounded-lg p-3 transition-colors hover:bg-muted/50',
                          state.recipeId === r.id && 'ring-2 ring-primary border-primary'
                        )}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-lg">{r.icon}</span>
                          <span className="text-sm font-medium">{r.name}</span>
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-2">{r.description}</p>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Templates */}
              {templates.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
                    <BookTemplate className="h-4 w-4" />
                    Templates — customizable starting points
                  </h3>
                  <div className="grid grid-cols-2 gap-3">
                    {templates.slice(0, 8).map((t) => (
                      <button
                        key={t.id}
                        onClick={() => selectTemplate(t)}
                        className={cn(
                          'text-left border rounded-lg p-3 transition-colors hover:bg-muted/50',
                          state.templateId === t.id && state.source === 'template' && 'ring-2 ring-primary border-primary'
                        )}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-lg">{t.icon}</span>
                          <span className="text-sm font-medium">{t.name}</span>
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-2">{t.description}</p>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Blank */}
              <button
                onClick={() => update({ source: 'blank', templateId: null, recipeId: null })}
                className={cn(
                  'w-full text-left border border-dashed rounded-lg p-4 transition-colors hover:bg-muted/50',
                  state.source === 'blank' && !state.templateId && !state.recipeId && 'ring-2 ring-primary border-primary'
                )}
              >
                <div className="flex items-center gap-2">
                  <Wand2 className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <span className="text-sm font-medium">Start from scratch</span>
                    <p className="text-xs text-muted-foreground">Configure everything yourself</p>
                  </div>
                </div>
              </button>
            </div>
          )}

          {/* Step 1: Personality */}
          {state.step === 1 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold">Define your agent's personality</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Give your agent a name and describe how it should behave.
                </p>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium block mb-1.5">Agent Name *</label>
                  <input
                    type="text"
                    value={state.agentName}
                    onChange={(e) => update({ agentName: e.target.value })}
                    placeholder="e.g. CodeBot, ResearchHelper, DevOps Watcher"
                    className="w-full px-3 py-2 border rounded-lg text-sm bg-background"
                  />
                </div>

                <div>
                  <label className="text-sm font-medium block mb-1.5">Emoji</label>
                  <div className="flex flex-wrap gap-2">
                    {EMOJI_OPTIONS.map((emoji) => (
                      <button
                        key={emoji}
                        onClick={() => update({ agentEmoji: emoji })}
                        className={cn(
                          'w-10 h-10 rounded-lg border text-lg flex items-center justify-center transition-colors',
                          state.agentEmoji === emoji
                            ? 'ring-2 ring-primary border-primary bg-primary/10'
                            : 'hover:bg-muted'
                        )}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium block mb-1.5">Tagline</label>
                  <input
                    type="text"
                    value={state.agentTagline}
                    onChange={(e) => update({ agentTagline: e.target.value })}
                    placeholder="e.g. Your GitHub watchdog"
                    className="w-full px-3 py-2 border rounded-lg text-sm bg-background"
                  />
                </div>

                <div>
                  <label className="text-sm font-medium block mb-1.5">
                    Personality & Behavior
                  </label>
                  <textarea
                    value={state.soulDescription}
                    onChange={(e) => update({ soulDescription: e.target.value })}
                    placeholder="Describe how your agent should behave. What's its tone? What are its boundaries? What should it prioritize?"
                    className="w-full px-3 py-2 border rounded-lg text-sm bg-background resize-none h-32"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Capabilities (MCP Servers) */}
          {state.step === 2 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold">Add capabilities</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Toggle MCP servers to give your agent additional tools.
                </p>
              </div>

              <div className="space-y-2">
                {mcpCatalog.map((entry) => {
                  const isEnabled = state.enabledMCP.includes(entry.id)
                  return (
                    <button
                      key={entry.id}
                      onClick={() => {
                        update({
                          enabledMCP: isEnabled
                            ? state.enabledMCP.filter((id) => id !== entry.id)
                            : [...state.enabledMCP, entry.id],
                        })
                      }}
                      className={cn(
                        'w-full text-left border rounded-lg p-3 flex items-center gap-3 transition-colors',
                        isEnabled ? 'ring-1 ring-primary border-primary bg-primary/5' : 'hover:bg-muted/50'
                      )}
                    >
                      <span className="text-lg">{entry.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium">{entry.name}</div>
                        <div className="text-xs text-muted-foreground truncate">{entry.description}</div>
                      </div>
                      <div
                        className={cn(
                          'w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors',
                          isEnabled ? 'bg-primary border-primary' : 'border-muted-foreground/30'
                        )}
                      >
                        {isEnabled && <Check className="h-3 w-3 text-primary-foreground" />}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Step 3: Schedule */}
          {state.step === 3 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold">Set schedule</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Configure when your agent runs autonomously.
                </p>
              </div>

              <div className="space-y-4">
                <div className="flex items-center justify-between border rounded-lg p-4">
                  <div>
                    <div className="text-sm font-medium">Autonomous Heartbeat</div>
                    <div className="text-xs text-muted-foreground">
                      Agent runs its HEARTBEAT.md checklist on a timer
                    </div>
                  </div>
                  <button
                    onClick={() => update({ heartbeatEnabled: !state.heartbeatEnabled })}
                    className={cn(
                      'w-10 h-5 rounded-full transition-colors relative',
                      state.heartbeatEnabled ? 'bg-primary' : 'bg-muted-foreground/20'
                    )}
                  >
                    <div
                      className={cn(
                        'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
                        state.heartbeatEnabled ? 'translate-x-5' : 'translate-x-0.5'
                      )}
                    />
                  </button>
                </div>

                {state.heartbeatEnabled && (
                  <>
                    <div>
                      <label className="text-sm font-medium block mb-1.5">Heartbeat Interval</label>
                      <div className="flex gap-2">
                        {[
                          { label: '10 min', value: 600 },
                          { label: '15 min', value: 900 },
                          { label: '30 min', value: 1800 },
                          { label: '1 hour', value: 3600 },
                          { label: '12 hours', value: 43200 },
                          { label: '24 hours', value: 86400 },
                        ].map((opt) => (
                          <button
                            key={opt.value}
                            onClick={() => update({ heartbeatInterval: opt.value })}
                            className={cn(
                              'px-3 py-1.5 rounded-lg text-xs border transition-colors',
                              state.heartbeatInterval === opt.value
                                ? 'bg-primary text-primary-foreground border-primary'
                                : 'hover:bg-muted'
                            )}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="text-sm font-medium block mb-1.5">Quiet Hours (UTC)</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="time"
                          value={state.quietHoursStart}
                          onChange={(e) => update({ quietHoursStart: e.target.value })}
                          className="px-2 py-1.5 border rounded-lg text-sm bg-background"
                        />
                        <span className="text-sm text-muted-foreground">to</span>
                        <input
                          type="time"
                          value={state.quietHoursEnd}
                          onChange={(e) => update({ quietHoursEnd: e.target.value })}
                          className="px-2 py-1.5 border rounded-lg text-sm bg-background"
                        />
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        Agent won't send messages during quiet hours
                      </p>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Step 4: Review */}
          {state.step === 4 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold">Review your agent</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Everything looks good? Deploy your agent.
                </p>
              </div>

              <div className="border rounded-lg divide-y">
                <div className="p-4 flex items-center gap-3">
                  <span className="text-2xl">{state.agentEmoji}</span>
                  <div>
                    <div className="font-medium">{state.agentName || 'Unnamed Agent'}</div>
                    {state.agentTagline && (
                      <div className="text-sm text-muted-foreground">{state.agentTagline}</div>
                    )}
                  </div>
                </div>

                <div className="p-4">
                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                    Source
                  </div>
                  <p className="text-sm">
                    {state.source === 'recipe' ? `Recipe: ${recipes.find((r) => r.id === state.recipeId)?.name}` :
                     state.source === 'template' ? `Template: ${templates.find((t) => t.id === state.templateId)?.name}` :
                     'Blank (from scratch)'}
                  </p>
                </div>

                <div className="p-4">
                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                    MCP Servers ({state.enabledMCP.length})
                  </div>
                  {state.enabledMCP.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {state.enabledMCP.map((id) => {
                        const entry = mcpCatalog.find((e) => e.id === id)
                        return (
                          <span key={id} className="inline-flex items-center gap-1 px-2 py-1 bg-muted rounded text-xs">
                            <span>{entry?.icon}</span>
                            {entry?.name || id}
                          </span>
                        )
                      })}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">None (built-in tools only)</p>
                  )}
                </div>

                <div className="p-4">
                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                    Schedule
                  </div>
                  <p className="text-sm">
                    {state.heartbeatEnabled
                      ? `Every ${state.heartbeatInterval >= 3600
                          ? `${state.heartbeatInterval / 3600} hour${state.heartbeatInterval > 3600 ? 's' : ''}`
                          : `${state.heartbeatInterval / 60} minutes`}${
                        state.quietHoursStart ? ` (quiet ${state.quietHoursStart}–${state.quietHoursEnd} UTC)` : ''}`
                      : 'Heartbeat disabled (responds to messages only)'}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Navigation buttons */}
      <div className="px-6 py-4 border-t flex items-center justify-between">
        <button
          onClick={() => update({ step: state.step - 1 })}
          disabled={state.step === 0}
          className="flex items-center gap-1 px-4 py-2 text-sm rounded-lg border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="h-4 w-4" />
          Back
        </button>

        {state.step < STEPS.length - 1 ? (
          <button
            onClick={() => update({ step: state.step + 1 })}
            disabled={!canProceed}
            className="flex items-center gap-1 px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </button>
        ) : (
          <button
            onClick={handleDeploy}
            disabled={isDeploying}
            className="flex items-center gap-1 px-6 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Rocket className="h-4 w-4" />
            {isDeploying ? 'Deploying...' : 'Deploy Agent'}
          </button>
        )}
      </div>
    </div>
  )
}
