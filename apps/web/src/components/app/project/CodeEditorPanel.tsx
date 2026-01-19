/**
 * CodeEditorPanel - Monaco-based code editor for project files (Lovable.dev-inspired)
 *
 * Features:
 * - File tree sidebar with collapsible directories
 * - Monaco Editor with full syntax highlighting
 * - Language detection from file extension
 * - Dark theme matching the app
 * - S3 pre-signed URLs for direct file access
 * - Auto-save with debouncing
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import Editor from "@monaco-editor/react"
import { Loader2, FileText, Folder, FolderOpen, ChevronRight, ChevronDown, RefreshCw, Cloud, CloudOff } from "lucide-react"
import { cn } from "@/lib/utils"

/** Auto-save debounce delay in ms */
const AUTO_SAVE_DELAY = 1500

/**
 * File info from the API.
 */
interface FileInfo {
  path: string
  name: string
  type: 'file' | 'directory'
  extension?: string
  size?: number
}

/**
 * Tree node for rendering the file tree.
 */
interface TreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  extension?: string
  children?: TreeNode[]
  expanded?: boolean
}

export interface CodeEditorPanelProps {
  /** Project ID to load files for */
  projectId: string
  /** Additional CSS classes */
  className?: string
  /** Callback when file content changes */
  onFileChange?: (path: string, content: string) => void
}

/**
 * Build a tree structure from flat file list.
 */
function buildFileTree(files: FileInfo[]): TreeNode[] {
  const root: TreeNode[] = []
  const directories: Map<string, TreeNode> = new Map()

  // Sort files: directories first, then alphabetically
  const sortedFiles = [...files].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.path.localeCompare(b.path)
  })

  for (const file of sortedFiles) {
    const parts = file.path.split('/')
    let currentPath = ''
    let currentLevel = root

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLast = i === parts.length - 1
      currentPath = currentPath ? `${currentPath}/${part}` : part

      if (isLast) {
        currentLevel.push({
          name: part,
          path: file.path,
          type: file.type,
          extension: file.extension,
          children: file.type === 'directory' ? [] : undefined,
          expanded: false,
        })
        if (file.type === 'directory') {
          directories.set(file.path, currentLevel[currentLevel.length - 1])
        }
      } else {
        let dir = directories.get(currentPath)
        if (!dir) {
          dir = {
            name: part,
            path: currentPath,
            type: 'directory',
            children: [],
            expanded: true,
          }
          currentLevel.push(dir)
          directories.set(currentPath, dir)
        }
        currentLevel = dir.children!
      }
    }
  }

  return root
}

/**
 * Get Monaco language from file extension.
 */
function getMonacoLanguage(extension?: string): string {
  const languageMap: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.json': 'json',
    '.css': 'css',
    '.scss': 'scss',
    '.less': 'less',
    '.html': 'html',
    '.md': 'markdown',
    '.svg': 'xml',
    '.xml': 'xml',
    '.yaml': 'yaml',
    '.yml': 'yaml',
  }
  return extension ? languageMap[extension] || 'plaintext' : 'plaintext'
}

/**
 * File tree item component.
 */
function FileTreeItem({
  node,
  depth,
  selectedPath,
  onSelect,
  onToggle,
}: {
  node: TreeNode
  depth: number
  selectedPath: string | null
  onSelect: (path: string) => void
  onToggle: (path: string) => void
}) {
  const isSelected = selectedPath === node.path
  const isDirectory = node.type === 'directory'
  const hasChildren = isDirectory && node.children && node.children.length > 0

  const handleClick = () => {
    if (isDirectory) {
      onToggle(node.path)
    } else {
      onSelect(node.path)
    }
  }

  // File icon color based on extension
  const getFileColor = () => {
    switch (node.extension) {
      case '.tsx':
      case '.ts':
        return 'text-blue-400'
      case '.jsx':
      case '.js':
        return 'text-yellow-400'
      case '.css':
      case '.scss':
        return 'text-pink-400'
      case '.json':
        return 'text-green-400'
      case '.html':
        return 'text-orange-400'
      case '.md':
        return 'text-gray-400'
      default:
        return 'text-muted-foreground'
    }
  }

  return (
    <>
      <button
        onClick={handleClick}
        className={cn(
          "w-full flex items-center gap-1 px-2 py-0.5 text-[13px] text-left hover:bg-[#2a2d2e] transition-colors",
          isSelected && "bg-[#094771] text-white"
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {/* Expand/collapse icon for directories */}
        {isDirectory ? (
          hasChildren ? (
            node.expanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            )
          ) : (
            <span className="w-4" />
          )
        ) : (
          <span className="w-4" />
        )}

        {/* Icon */}
        {isDirectory ? (
          node.expanded ? (
            <FolderOpen className="h-4 w-4 text-amber-400 shrink-0" />
          ) : (
            <Folder className="h-4 w-4 text-amber-400 shrink-0" />
          )
        ) : (
          <FileText className={cn("h-4 w-4 shrink-0", getFileColor())} />
        )}

        {/* Name */}
        <span className="truncate">{node.name}</span>
      </button>

      {/* Render children if expanded */}
      {isDirectory && node.expanded && node.children?.map((child) => (
        <FileTreeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onToggle={onToggle}
        />
      ))}
    </>
  )
}

export function CodeEditorPanel({
  projectId,
  className,
  onFileChange,
}: CodeEditorPanelProps) {
  const [files, setFiles] = useState<FileInfo[]>([])
  const [isLoadingFiles, setIsLoadingFiles] = useState(true)
  const [filesError, setFilesError] = useState<string | null>(null)

  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string>('')
  const [originalContent, setOriginalContent] = useState<string>('') // Track original for dirty detection
  const [isLoadingContent, setIsLoadingContent] = useState(false)
  const [contentError, setContentError] = useState<string | null>(null)

  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(['src']))

  // Save state
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [lastSaved, setLastSaved] = useState<Date | null>(null)
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Track if content has unsaved changes
  const isDirty = fileContent !== originalContent

  // Build file tree from flat list
  const fileTree = useMemo(() => {
    const tree = buildFileTree(files)
    const applyExpanded = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.type === 'directory') {
          node.expanded = expandedDirs.has(node.path)
          if (node.children) applyExpanded(node.children)
        }
      }
    }
    applyExpanded(tree)
    return tree
  }, [files, expandedDirs])

  // Load file list from S3
  const loadFiles = useCallback(async () => {
    setIsLoadingFiles(true)
    setFilesError(null)

    try {
      // Use S3 endpoint for file listing
      const response = await fetch(`/api/projects/${projectId}/s3/files`)
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error?.message || 'Failed to load files')
      }

      setFiles(data.files || [])
      setExpandedDirs(new Set(['src']))

      // Auto-select App.tsx or first file
      const appFile = data.files?.find((f: FileInfo) =>
        f.type === 'file' && f.path.endsWith('App.tsx')
      )
      const firstFile = appFile || data.files?.find((f: FileInfo) => f.type === 'file')
      if (firstFile) {
        setSelectedFile(firstFile.path)
      }
    } catch (err: any) {
      setFilesError(err.message || 'Failed to load files')
    } finally {
      setIsLoadingFiles(false)
    }
  }, [projectId])

  // Load file content via S3 pre-signed URL
  const loadFileContent = useCallback(async (filePath: string) => {
    setIsLoadingContent(true)
    setContentError(null)
    setSaveError(null)

    try {
      // Get pre-signed URL for reading
      const presignResponse = await fetch(`/api/projects/${projectId}/s3/presign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: [{ path: filePath, action: 'read' }]
        })
      })
      const presignData = await presignResponse.json()

      if (!presignResponse.ok) {
        throw new Error(presignData.error?.message || 'Failed to get file URL')
      }

      const readUrl = presignData.urls?.[0]?.url
      if (!readUrl) {
        throw new Error('No pre-signed URL returned')
      }

      // Fetch content directly from S3
      const contentResponse = await fetch(readUrl)
      if (!contentResponse.ok) {
        throw new Error(`Failed to load file: ${contentResponse.status}`)
      }

      const content = await contentResponse.text()
      setFileContent(content)
      setOriginalContent(content) // Track original for dirty detection
      setLastSaved(new Date())
    } catch (err: any) {
      setContentError(err.message || 'Failed to load file')
      setFileContent('')
      setOriginalContent('')
    } finally {
      setIsLoadingContent(false)
    }
  }, [projectId])

  // Load files on mount
  useEffect(() => {
    loadFiles()
  }, [loadFiles])

  // Load content when file is selected
  useEffect(() => {
    if (selectedFile) {
      loadFileContent(selectedFile)
    }
  }, [selectedFile, loadFileContent])

  // Handle file selection
  const handleFileSelect = (path: string) => {
    setSelectedFile(path)
  }

  // Handle directory toggle
  const handleToggleDir = (path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  // Save file content via S3 pre-signed URL
  const saveFile = useCallback(async (content: string) => {
    if (!selectedFile) return

    setIsSaving(true)
    setSaveError(null)

    try {
      // Get file extension for content type
      const ext = files.find(f => f.path === selectedFile)?.extension || ''
      const contentTypes: Record<string, string> = {
        '.ts': 'text/typescript',
        '.tsx': 'text/typescript',
        '.js': 'text/javascript',
        '.jsx': 'text/javascript',
        '.json': 'application/json',
        '.css': 'text/css',
        '.html': 'text/html',
        '.md': 'text/markdown',
        '.svg': 'image/svg+xml',
      }
      const contentType = contentTypes[ext] || 'text/plain'

      // Get pre-signed URL for writing
      const presignResponse = await fetch(`/api/projects/${projectId}/s3/presign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: [{ path: selectedFile, action: 'write', contentType }]
        })
      })
      const presignData = await presignResponse.json()

      if (!presignResponse.ok) {
        throw new Error(presignData.error?.message || 'Failed to get upload URL')
      }

      const writeUrl = presignData.urls?.[0]?.url
      if (!writeUrl) {
        throw new Error('No pre-signed URL returned')
      }

      // PUT content directly to S3
      const uploadResponse = await fetch(writeUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: content
      })

      if (!uploadResponse.ok) {
        throw new Error(`Failed to save file: ${uploadResponse.status}`)
      }

      setOriginalContent(content) // Update original to match saved content
      setLastSaved(new Date())
      onFileChange?.(selectedFile, content)
    } catch (err: any) {
      setSaveError(err.message || 'Failed to save file')
    } finally {
      setIsSaving(false)
    }
  }, [selectedFile, files, projectId, onFileChange])

  // Handle editor content changes with debounced auto-save
  const handleEditorChange = useCallback((value: string | undefined) => {
    const newContent = value || ''
    setFileContent(newContent)

    // Clear existing timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }

    // Set new timeout for auto-save (only if content changed from original)
    if (newContent !== originalContent) {
      saveTimeoutRef.current = setTimeout(() => {
        saveFile(newContent)
      }, AUTO_SAVE_DELAY)
    }
  }, [originalContent, saveFile])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [])

  // Get current file extension for language detection
  const currentExtension = selectedFile
    ? files.find(f => f.path === selectedFile)?.extension
    : undefined
  const language = getMonacoLanguage(currentExtension)

  return (
    <div className={cn("flex h-full bg-[#1e1e1e]", className)}>
      {/* File Tree Sidebar */}
      <div className="w-56 shrink-0 border-r border-[#3c3c3c] flex flex-col bg-[#252526]">
        <div className="flex items-center justify-between px-3 py-2 border-b border-[#3c3c3c]">
          <span className="text-[11px] font-semibold text-[#bbbbbb] uppercase tracking-wider">
            Explorer
          </span>
          <button
            onClick={loadFiles}
            className="p-1 hover:bg-[#3c3c3c] rounded transition-colors"
            title="Refresh files"
          >
            <RefreshCw className={cn(
              "h-3.5 w-3.5 text-[#888888]",
              isLoadingFiles && "animate-spin"
            )} />
          </button>
        </div>

        <div className="flex-1 overflow-auto py-1">
          {isLoadingFiles ? (
            <div className="flex items-center justify-center p-4">
              <Loader2 className="h-5 w-5 animate-spin text-[#888888]" />
            </div>
          ) : filesError ? (
            <div className="p-4 text-center">
              <p className="text-sm text-red-400">{filesError}</p>
              <button
                onClick={loadFiles}
                className="mt-2 text-xs text-blue-400 hover:underline"
              >
                Retry
              </button>
            </div>
          ) : fileTree.length === 0 ? (
            <div className="p-4 text-center text-sm text-[#888888]">
              No files found
            </div>
          ) : (
            fileTree.map((node) => (
              <FileTreeItem
                key={node.path}
                node={node}
                depth={0}
                selectedPath={selectedFile}
                onSelect={handleFileSelect}
                onToggle={handleToggleDir}
              />
            ))
          )}
        </div>
      </div>

      {/* Monaco Editor */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* File tabs with save status */}
        {selectedFile && (
          <div className="flex items-center justify-between h-9 bg-[#252526] border-b border-[#3c3c3c]">
            <div className="flex items-center px-3 h-full bg-[#1e1e1e] border-r border-[#3c3c3c]">
              <FileText className="h-4 w-4 text-[#888888] mr-2" />
              <span className="text-[13px] text-[#cccccc]">
                {selectedFile.split('/').pop()}
              </span>
              {/* Dirty indicator */}
              {isDirty && (
                <span className="ml-1 w-2 h-2 rounded-full bg-white/70" title="Unsaved changes" />
              )}
            </div>
            {/* Save status indicator */}
            <div className="flex items-center gap-2 px-3 text-[11px]">
              {saveError ? (
                <span className="flex items-center gap-1 text-red-400">
                  <CloudOff className="h-3.5 w-3.5" />
                  {saveError}
                </span>
              ) : isSaving ? (
                <span className="flex items-center gap-1 text-[#888888]">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Saving...
                </span>
              ) : lastSaved ? (
                <span className="flex items-center gap-1 text-[#888888]">
                  <Cloud className="h-3.5 w-3.5" />
                  Saved
                </span>
              ) : null}
            </div>
          </div>
        )}

        {/* Editor content */}
        <div className="flex-1">
          {isLoadingContent ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-6 w-6 animate-spin text-[#888888]" />
            </div>
          ) : contentError ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-red-400">{contentError}</p>
            </div>
          ) : !selectedFile ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-[#888888]">Select a file to view</p>
            </div>
          ) : (
            <Editor
              height="100%"
              language={language}
              value={fileContent}
              theme="vs-dark"
              onChange={handleEditorChange}
              options={{
                minimap: { enabled: true },
                fontSize: 13,
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                automaticLayout: true,
                wordWrap: 'on',
                padding: { top: 8 },
                tabSize: 2,
              }}
              loading={
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="h-6 w-6 animate-spin text-[#888888]" />
                </div>
              }
            />
          )}
        </div>
      </div>
    </div>
  )
}

export default CodeEditorPanel
