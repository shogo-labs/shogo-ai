/**
 * AgentWorkspacePanel
 *
 * File editor for agent workspace files (AGENTS.md, SOUL.md, etc.)
 * Fetches files from the agent runtime and allows inline editing.
 */

import { useState, useEffect, useCallback } from 'react'
import { FileText, Save, RefreshCw, Eye, Pencil, Download, Upload } from 'lucide-react'
import { Streamdown } from 'streamdown'
import { cn } from '@/lib/utils'
import { useAgentUrl } from '@/hooks/useAgentUrl'

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
  localAgentUrl?: string | null
}

export function AgentWorkspacePanel({ projectId, visible, localAgentUrl }: AgentWorkspacePanelProps) {
  const [selectedFile, setSelectedFile] = useState(WORKSPACE_FILES[0].id)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPreview, setIsPreview] = useState(false)
  const { refetch: getAgentUrl } = useAgentUrl(projectId, localAgentUrl)

  const [isExporting, setIsExporting] = useState(false)
  const [importRef] = useState(() => ({ current: null as HTMLInputElement | null }))

  const hasChanges = content !== savedContent

  const handleExport = useCallback(async () => {
    setIsExporting(true)
    try {
      const baseUrl = await getAgentUrl()
      const res = await fetch(`${baseUrl}/agent/export`)
      if (!res.ok) throw new Error('Failed to export')
      const bundle = await res.json()
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `agent-${projectId.slice(0, 8)}.shogo.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsExporting(false)
    }
  }, [getAgentUrl, projectId])

  const handleImport = useCallback(async (file: File) => {
    try {
      const text = await file.text()
      const bundle = JSON.parse(text)
      const baseUrl = await getAgentUrl()
      const res = await fetch(`${baseUrl}/agent/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bundle),
      })
      if (!res.ok) throw new Error('Failed to import')
      const data = await res.json()
      loadFile(selectedFile)
      setError(null)
    } catch (err: any) {
      setError(err.message)
    }
  }, [getAgentUrl, selectedFile])

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
      <div className="w-48 border-r bg-muted/30 overflow-y-auto flex flex-col">
        <div className="p-2 flex-1">
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
        <div className="p-2 border-t space-y-1">
          <button
            onClick={handleExport}
            disabled={isExporting}
            className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <Download className="h-3 w-3" />
            {isExporting ? 'Exporting...' : 'Export Agent'}
          </button>
          <button
            onClick={() => importRef.current?.click()}
            className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <Upload className="h-3 w-3" />
            Import Agent
          </button>
          <input
            ref={(el) => { importRef.current = el }}
            type="file"
            accept=".json,.shogo.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) handleImport(file)
              e.target.value = ''
            }}
          />
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
