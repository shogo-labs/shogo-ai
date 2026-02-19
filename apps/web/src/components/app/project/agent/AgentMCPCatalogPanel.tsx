/**
 * AgentMCPCatalogPanel
 *
 * Browse and toggle prepackaged MCP servers for an agent.
 * Each server is a toggleable card showing what tools it provides.
 * Enabling a server adds it to the agent's config.json; disabling removes it.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Server, RefreshCw, Check, ChevronDown, ChevronRight, Key, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAgentUrl } from '@/hooks/useAgentUrl'

interface MCPCatalogEntry {
  id: string
  name: string
  description: string
  category: string
  package: string
  requiredEnv: Record<string, string>
  optionalEnv?: Record<string, string>
  providedTools: string[]
  icon: string
  cloudCompatible: boolean
}

interface CategoryMeta {
  label: string
  icon: string
}

interface AgentMCPCatalogPanelProps {
  projectId: string
  visible: boolean
  localAgentUrl?: string | null
}

export function AgentMCPCatalogPanel({ projectId, visible, localAgentUrl }: AgentMCPCatalogPanelProps) {
  const [catalog, setCatalog] = useState<MCPCatalogEntry[]>([])
  const [categories, setCategories] = useState<Record<string, CategoryMeta>>({})
  const [enabledServers, setEnabledServers] = useState<Record<string, any>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [toggling, setToggling] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null)
  const [envInputs, setEnvInputs] = useState<Record<string, Record<string, string>>>({})
  const [showEnvForm, setShowEnvForm] = useState<string | null>(null)
  const { refetch: getAgentUrl } = useAgentUrl(projectId, localAgentUrl)

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const baseUrl = await getAgentUrl()

      const [catalogRes, statusRes] = await Promise.all([
        fetch(`${baseUrl}/agent/mcp-catalog`),
        fetch(`${baseUrl}/agent/status`),
      ])

      if (!catalogRes.ok) throw new Error('Failed to load MCP catalog')
      const catalogData = await catalogRes.json()
      setCatalog(catalogData.catalog || [])
      setCategories(catalogData.categories || {})

      if (statusRes.ok) {
        const status = await statusRes.json()
        const configRes = await fetch(`${baseUrl}/agent/files/config.json`)
        if (configRes.ok) {
          const configData = await configRes.json()
          try {
            const config = JSON.parse(configData.content || '{}')
            setEnabledServers(config.mcpServers || {})
          } catch {
            setEnabledServers({})
          }
        }
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }, [getAgentUrl])

  useEffect(() => {
    if (visible) loadData()
  }, [visible, loadData])

  const handleToggle = useCallback(async (entry: MCPCatalogEntry) => {
    const isEnabled = entry.id in enabledServers
    const needsEnv = !isEnabled && Object.keys(entry.requiredEnv).length > 0

    if (needsEnv) {
      const currentEnvs = envInputs[entry.id] || {}
      const allFilled = Object.keys(entry.requiredEnv).every((k) => currentEnvs[k]?.trim())

      if (!allFilled) {
        setShowEnvForm(entry.id)
        return
      }
    }

    setToggling(entry.id)
    try {
      const baseUrl = await getAgentUrl()
      const env = envInputs[entry.id] || {}
      const res = await fetch(`${baseUrl}/agent/mcp-servers/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: entry.id,
          enabled: !isEnabled,
          env: Object.keys(env).length > 0 ? env : undefined,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to toggle server')
      }

      const data = await res.json()
      setEnabledServers(data.servers || {})
      setShowEnvForm(null)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setToggling(null)
    }
  }, [enabledServers, envInputs, getAgentUrl])

  const grouped = useMemo(() => {
    const groups: Record<string, MCPCatalogEntry[]> = {}
    for (const entry of catalog) {
      if (!groups[entry.category]) groups[entry.category] = []
      groups[entry.category].push(entry)
    }
    return groups
  }, [catalog])

  const enabledCount = Object.keys(enabledServers).length

  return (
    <div className={cn('absolute inset-0 flex flex-col', !visible && 'invisible pointer-events-none')}>
      <div className="px-4 py-3 border-b flex items-center gap-2">
        <Server className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">MCP Servers</span>
        <span className="text-xs text-muted-foreground">
          {enabledCount} enabled
        </span>
        <button
          onClick={loadData}
          className="ml-auto p-1 rounded hover:bg-muted text-muted-foreground"
          title="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 bg-destructive/10 text-destructive text-xs">{error}</div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="text-sm text-muted-foreground text-center py-8">Loading catalog...</div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Toggle MCP servers to give your agent additional capabilities. Each server provides specialized tools.
            </p>

            {Object.entries(grouped).map(([categoryId, entries]) => {
              const catMeta = categories[categoryId] || { label: categoryId, icon: '📦' }
              const isExpanded = expandedCategory === categoryId || expandedCategory === null
              const enabledInCategory = entries.filter((e) => e.id in enabledServers).length

              return (
                <div key={categoryId} className="border rounded-lg overflow-hidden">
                  <button
                    onClick={() => setExpandedCategory(isExpanded && expandedCategory !== null ? null : categoryId)}
                    className="w-full px-3 py-2 flex items-center gap-2 hover:bg-muted/50 transition-colors"
                  >
                    <span className="text-sm">{catMeta.icon}</span>
                    <span className="text-xs font-medium flex-1 text-left">{catMeta.label}</span>
                    {enabledInCategory > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                        {enabledInCategory} active
                      </span>
                    )}
                    {isExpanded ? (
                      <ChevronDown className="h-3 w-3 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3 w-3 text-muted-foreground" />
                    )}
                  </button>

                  {isExpanded && (
                    <div className="border-t">
                      {entries.map((entry) => {
                        const isEnabled = entry.id in enabledServers
                        const isToggling = toggling === entry.id
                        const showingEnv = showEnvForm === entry.id

                        return (
                          <div key={entry.id} className="border-b last:border-b-0">
                            <div className="px-3 py-2.5 flex items-start gap-3">
                              <span className="text-lg mt-0.5">{entry.icon}</span>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium">{entry.name}</span>
                                  {!entry.cloudCompatible && (
                                    <span className="text-[10px] px-1 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">
                                      Desktop only
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                                  {entry.description}
                                </p>
                                <div className="mt-1.5 flex flex-wrap gap-1">
                                  {entry.providedTools.slice(0, 4).map((tool) => (
                                    <span
                                      key={tool}
                                      className="inline-block px-1.5 py-0.5 bg-muted text-[10px] rounded text-muted-foreground"
                                    >
                                      {tool}
                                    </span>
                                  ))}
                                  {entry.providedTools.length > 4 && (
                                    <span className="text-[10px] text-muted-foreground">
                                      +{entry.providedTools.length - 4} more
                                    </span>
                                  )}
                                </div>
                                {Object.keys(entry.requiredEnv).length > 0 && !isEnabled && (
                                  <div className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                                    <Key className="h-2.5 w-2.5" />
                                    Requires: {Object.keys(entry.requiredEnv).join(', ')}
                                  </div>
                                )}
                              </div>
                              <button
                                onClick={() => handleToggle(entry)}
                                disabled={isToggling}
                                className={cn(
                                  'mt-1 shrink-0 w-10 h-5 rounded-full transition-colors relative',
                                  isEnabled
                                    ? 'bg-primary'
                                    : 'bg-muted-foreground/20 hover:bg-muted-foreground/30',
                                  isToggling && 'opacity-50'
                                )}
                              >
                                <div
                                  className={cn(
                                    'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
                                    isEnabled ? 'translate-x-5' : 'translate-x-0.5'
                                  )}
                                />
                              </button>
                            </div>

                            {showingEnv && (
                              <div className="px-3 pb-3 ml-9">
                                <div className="border rounded-md p-3 bg-muted/30 space-y-2">
                                  <p className="text-xs font-medium">Required credentials</p>
                                  {Object.entries(entry.requiredEnv).map(([key, desc]) => (
                                    <div key={key}>
                                      <label className="text-[10px] text-muted-foreground block mb-0.5">
                                        {key}
                                      </label>
                                      <input
                                        type="password"
                                        placeholder={desc}
                                        value={envInputs[entry.id]?.[key] || ''}
                                        onChange={(e) =>
                                          setEnvInputs((prev) => ({
                                            ...prev,
                                            [entry.id]: { ...prev[entry.id], [key]: e.target.value },
                                          }))
                                        }
                                        className="w-full px-2 py-1 text-xs border rounded bg-background"
                                      />
                                    </div>
                                  ))}
                                  <div className="flex gap-2 mt-2">
                                    <button
                                      onClick={() => handleToggle(entry)}
                                      className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
                                    >
                                      Enable
                                    </button>
                                    <button
                                      onClick={() => setShowEnvForm(null)}
                                      className="px-3 py-1 text-xs border rounded hover:bg-muted"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
