/**
 * AgentWorkspacePanel
 *
 * File editor for agent workspace files (AGENTS.md, SOUL.md, etc.)
 * Fetches files from the agent runtime and allows inline editing.
 */

import { useState, useEffect, useCallback } from 'react'
import { FileText, Save, RefreshCw, Eye, Pencil } from 'lucide-react'
import { Streamdown } from 'streamdown'
import { cn } from '@/lib/utils'

const WORKSPACE_FILES = [
  { id: 'AGENTS.md', label: 'Instructions', description: 'Operating rules and priorities' },
  { id: 'SOUL.md', label: 'Persona', description: 'Personality and boundaries' },
  { id: 'USER.md', label: 'User', description: 'User preferences' },
  { id: 'IDENTITY.md', label: 'Identity', description: 'Name, emoji, tagline' },
  { id: 'HEARTBEAT.md', label: 'Heartbeat', description: 'Autonomous task checklist' },
  { id: 'MEMORY.md', label: 'Memory', description: 'Long-lived facts' },
  { id: 'TOOLS.md', label: 'Tools', description: 'Tool notes and conventions' },
]

interface AgentWorkspacePanelProps {
  projectId: string
  visible: boolean
}

export function AgentWorkspacePanel({ projectId, visible }: AgentWorkspacePanelProps) {
  const [selectedFile, setSelectedFile] = useState(WORKSPACE_FILES[0].id)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPreview, setIsPreview] = useState(false)

  const hasChanges = content !== savedContent

  const getAgentUrl = useCallback(async () => {
    const sandboxRes = await fetch(`/api/projects/${projectId}/sandbox/url`)
    if (!sandboxRes.ok) throw new Error('Agent not running')
    const sandboxData = await sandboxRes.json()
    return sandboxData.agentUrl || sandboxData.url
  }, [projectId])

  const loadFile = useCallback(async (filename: string) => {
    setIsLoading(true)
    setError(null)
    try {
      const baseUrl = await getAgentUrl()
      const res = await fetch(`${baseUrl}/agent/files/${filename}`)
      if (!res.ok) throw new Error('Failed to load file')
      const data = await res.json()
      setContent(data.content || '')
      setSavedContent(data.content || '')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }, [getAgentUrl])

  useEffect(() => {
    if (visible) {
      loadFile(selectedFile)
    }
  }, [visible, selectedFile, loadFile])

  const handleSave = async () => {
    setIsSaving(true)
    setError(null)
    try {
      const baseUrl = await getAgentUrl()
      const res = await fetch(`${baseUrl}/agent/files/${selectedFile}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      if (!res.ok) throw new Error('Failed to save file')
      setSavedContent(content)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className={cn('absolute inset-0 flex', !visible && 'invisible pointer-events-none')}>
      {/* File sidebar */}
      <div className="w-48 border-r bg-muted/30 overflow-y-auto">
        <div className="p-2">
          <div className="text-xs font-medium text-muted-foreground px-2 py-1">
            Workspace Files
          </div>
          {WORKSPACE_FILES.map((file) => (
            <button
              key={file.id}
              onClick={() => setSelectedFile(file.id)}
              className={cn(
                'w-full text-left px-2 py-1.5 rounded-md text-xs transition-colors',
                selectedFile === file.id
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              )}
            >
              <div className="flex items-center gap-1.5">
                <FileText className="h-3 w-3 flex-shrink-0" />
                <span className="truncate">{file.label}</span>
              </div>
              <div className="text-[10px] text-muted-foreground/70 ml-4.5 truncate">
                {file.description}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 flex flex-col">
        <div className="px-3 py-2 border-b flex items-center gap-2">
          <span className="text-sm font-medium">{selectedFile}</span>
          {hasChanges && (
            <span className="text-xs text-amber-500">unsaved</span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => setIsPreview(!isPreview)}
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors',
                isPreview
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              )}
              title={isPreview ? 'Edit' : 'Preview'}
            >
              {isPreview ? <Pencil className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {isPreview ? 'Edit' : 'Preview'}
            </button>
            <button
              onClick={() => loadFile(selectedFile)}
              className="p-1 rounded hover:bg-muted text-muted-foreground"
              title="Refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={handleSave}
              disabled={!hasChanges || isSaving}
              className="flex items-center gap-1 px-2 py-1 rounded-md bg-primary text-primary-foreground text-xs disabled:opacity-50"
            >
              <Save className="h-3 w-3" />
              Save
            </button>
          </div>
        </div>

        {error && (
          <div className="px-3 py-2 bg-destructive/10 text-destructive text-xs">
            {error}
          </div>
        )}

        {isPreview ? (
          <div className="flex-1 overflow-y-auto p-4 text-sm">
            {content ? (
              <Streamdown>{content}</Streamdown>
            ) : (
              <p className="text-muted-foreground italic">Nothing to preview</p>
            )}
          </div>
        ) : (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="flex-1 p-4 font-mono text-sm bg-background resize-none focus:outline-none"
            placeholder={`Edit ${selectedFile}...`}
            disabled={isLoading}
            spellCheck={false}
          />
        )}
      </div>
    </div>
  )
}
