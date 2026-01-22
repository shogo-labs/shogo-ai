/**
 * CodeEditorPanel - Monaco-based code editor for project files (Lovable.dev-inspired)
 *
 * Features:
 * - File tree sidebar with collapsible directories
 * - Monaco Editor with full syntax highlighting
 * - Language detection from file extension
 * - Theme-aware: syncs with app's dark/light mode via MutationObserver
 * - Filesystem API for file access (synced with Vite/Preview)
 * - Auto-save with debouncing (triggers Vite HMR)
 * - JSX/TSX support with proper TypeScript compiler options
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import Editor, { type Monaco } from "@monaco-editor/react"
import { Loader2, FileText, Folder, FolderOpen, ChevronRight, ChevronDown, RefreshCw, Cloud, CloudOff } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Configure Monaco Editor when it mounts.
 * This ensures TypeScript/JavaScript settings are correct for JSX/TSX files.
 */
function handleEditorWillMount(monaco: Monaco) {
  // Configure TypeScript/JavaScript compiler options for JSX support
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    allowNonTsExtensions: true,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    noEmit: true,
    esModuleInterop: true,
    jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
    reactNamespace: "React",
    allowJs: true,
    typeRoots: ["node_modules/@types"],
  })

  monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    allowNonTsExtensions: true,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    noEmit: true,
    esModuleInterop: true,
    jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
    reactNamespace: "React",
    allowJs: true,
  })

  // Enable semantic validation for TypeScript
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  })
}

/**
 * Hook to detect dark mode from document.documentElement.classList
 * Uses MutationObserver to react to theme changes
 */
function useIsDarkMode(): boolean {
  const [isDark, setIsDark] = useState(() => {
    if (typeof document === 'undefined') return true
    return document.documentElement.classList.contains('dark')
  })

  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'class') {
          setIsDark(document.documentElement.classList.contains('dark'))
        }
      }
    })

    observer.observe(document.documentElement, { attributes: true })
    return () => observer.disconnect()
  }, [])

  return isDark
}

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
  /** Trigger to force refresh files (increment to refresh) */
  refreshTrigger?: number
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
  // Note: Monaco's tokenizer uses 'typescript' for both .ts and .tsx files
  // The TypeScript language service handles JSX based on the file extension in the path prop
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
    '.prisma': 'graphql',  // Prisma schema has GraphQL-like syntax
    '.sql': 'sql',
    '.sh': 'shell',
    '.bash': 'shell',
    '.env': 'plaintext',
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
  isDarkMode,
}: {
  node: TreeNode
  depth: number
  selectedPath: string | null
  onSelect: (path: string) => void
  onToggle: (path: string) => void
  isDarkMode: boolean
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
          "w-full flex items-center gap-1 px-2 py-0.5 text-[13px] text-left transition-colors",
          isDarkMode ? "hover:bg-[#2a2d2e]" : "hover:bg-gray-100",
          isSelected && (isDarkMode ? "bg-[#094771] text-white" : "bg-blue-100 text-blue-900")
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
            <FolderOpen className={cn("h-4 w-4 shrink-0", isDarkMode ? "text-amber-400" : "text-amber-500")} />
          ) : (
            <Folder className={cn("h-4 w-4 shrink-0", isDarkMode ? "text-amber-400" : "text-amber-500")} />
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
          isDarkMode={isDarkMode}
        />
      ))}
    </>
  )
}

export function CodeEditorPanel({
  projectId,
  className,
  onFileChange,
  refreshTrigger,
}: CodeEditorPanelProps) {
  // Theme detection for Monaco
  const isDarkMode = useIsDarkMode()
  const monacoTheme = isDarkMode ? 'vs-dark' : 'vs'
  
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

  // Load file list from filesystem API (synced with Vite/Preview)
  const loadFiles = useCallback(async () => {
    setIsLoadingFiles(true)
    setFilesError(null)

    try {
      // Use filesystem endpoint for file listing (matches Vite's view)
      const response = await fetch(`/api/projects/${projectId}/files`)
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

  // Load file content via filesystem API (synced with Vite/Preview)
  const loadFileContent = useCallback(async (filePath: string) => {
    setIsLoadingContent(true)
    setContentError(null)
    setSaveError(null)

    try {
      // Use filesystem endpoint for reading (matches Vite's view)
      const response = await fetch(`/api/projects/${projectId}/files/${filePath}`)
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error?.message || 'Failed to load file')
      }

      const content = data.content || ''
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

  // Refresh files when refreshTrigger changes (agent made file modifications)
  useEffect(() => {
    if (refreshTrigger !== undefined && refreshTrigger > 0) {
      console.log('[CodeEditorPanel] 🔄 Refresh triggered by agent file modifications')
      loadFiles()
      // Also reload the currently selected file content
      if (selectedFile) {
        loadFileContent(selectedFile)
      }
    }
  }, [refreshTrigger, loadFiles, loadFileContent, selectedFile])

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

  // Save file content via filesystem API (synced with Vite/Preview)
  const saveFile = useCallback(async (content: string) => {
    if (!selectedFile) return

    setIsSaving(true)
    setSaveError(null)

    try {
      // Use filesystem endpoint for writing (triggers Vite HMR)
      const response = await fetch(`/api/projects/${projectId}/files/${selectedFile}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      })
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error?.message || 'Failed to save file')
      }

      setOriginalContent(content) // Update original to match saved content
      setLastSaved(new Date())
      onFileChange?.(selectedFile, content)
    } catch (err: any) {
      setSaveError(err.message || 'Failed to save file')
    } finally {
      setIsSaving(false)
    }
  }, [selectedFile, projectId, onFileChange])

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
    <div className={cn(
      "flex h-full",
      isDarkMode ? "bg-[#1e1e1e]" : "bg-white",
      className
    )}>
      {/* File Tree Sidebar */}
      <div className={cn(
        "w-56 shrink-0 border-r flex flex-col",
        isDarkMode ? "border-[#3c3c3c] bg-[#252526]" : "border-gray-200 bg-gray-50"
      )}>
        <div className={cn(
          "flex items-center justify-between px-3 py-2 border-b",
          isDarkMode ? "border-[#3c3c3c]" : "border-gray-200"
        )}>
          <span className={cn(
            "text-[11px] font-semibold uppercase tracking-wider",
            isDarkMode ? "text-[#bbbbbb]" : "text-gray-600"
          )}>
            Explorer
          </span>
          <button
            onClick={loadFiles}
            className={cn(
              "p-1 rounded transition-colors",
              isDarkMode ? "hover:bg-[#3c3c3c]" : "hover:bg-gray-200"
            )}
            title="Refresh files"
          >
            <RefreshCw className={cn(
              "h-3.5 w-3.5",
              isDarkMode ? "text-[#888888]" : "text-gray-500",
              isLoadingFiles && "animate-spin"
            )} />
          </button>
        </div>

        <div className="flex-1 overflow-auto py-1">
          {isLoadingFiles ? (
            <div className="flex items-center justify-center p-4">
              <Loader2 className={cn("h-5 w-5 animate-spin", isDarkMode ? "text-[#888888]" : "text-gray-400")} />
            </div>
          ) : filesError ? (
            <div className="p-4 text-center">
              <p className="text-sm text-red-500">{filesError}</p>
              <button
                onClick={loadFiles}
                className="mt-2 text-xs text-blue-500 hover:underline"
              >
                Retry
              </button>
            </div>
          ) : fileTree.length === 0 ? (
            <div className={cn("p-4 text-center text-sm", isDarkMode ? "text-[#888888]" : "text-gray-500")}>
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
                isDarkMode={isDarkMode}
              />
            ))
          )}
        </div>
      </div>

      {/* Monaco Editor */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* File tabs with save status */}
        {selectedFile && (
          <div className={cn(
            "flex items-center justify-between h-9 border-b",
            isDarkMode ? "bg-[#252526] border-[#3c3c3c]" : "bg-gray-100 border-gray-200"
          )}>
            <div className={cn(
              "flex items-center px-3 h-full border-r",
              isDarkMode ? "bg-[#1e1e1e] border-[#3c3c3c]" : "bg-white border-gray-200"
            )}>
              <FileText className={cn("h-4 w-4 mr-2", isDarkMode ? "text-[#888888]" : "text-gray-500")} />
              <span className={cn("text-[13px]", isDarkMode ? "text-[#cccccc]" : "text-gray-700")}>
                {selectedFile.split('/').pop()}
              </span>
              {/* Dirty indicator */}
              {isDirty && (
                <span className={cn(
                  "ml-1 w-2 h-2 rounded-full",
                  isDarkMode ? "bg-white/70" : "bg-blue-500"
                )} title="Unsaved changes" />
              )}
            </div>
            {/* Save status indicator */}
            <div className="flex items-center gap-2 px-3 text-[11px]">
              {saveError ? (
                <span className="flex items-center gap-1 text-red-500">
                  <CloudOff className="h-3.5 w-3.5" />
                  {saveError}
                </span>
              ) : isSaving ? (
                <span className={cn("flex items-center gap-1", isDarkMode ? "text-[#888888]" : "text-gray-500")}>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Saving...
                </span>
              ) : lastSaved ? (
                <span className={cn("flex items-center gap-1", isDarkMode ? "text-[#888888]" : "text-gray-500")}>
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
              <Loader2 className={cn("h-6 w-6 animate-spin", isDarkMode ? "text-[#888888]" : "text-gray-400")} />
            </div>
          ) : contentError ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-red-500">{contentError}</p>
            </div>
          ) : !selectedFile ? (
            <div className="flex items-center justify-center h-full">
              <p className={cn("text-sm", isDarkMode ? "text-[#888888]" : "text-gray-500")}>Select a file to view</p>
            </div>
          ) : (
            <Editor
              height="100%"
              path={selectedFile}
              defaultLanguage={language}
              value={fileContent}
              theme={monacoTheme}
              onChange={handleEditorChange}
              beforeMount={handleEditorWillMount}
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
                  <Loader2 className={cn("h-6 w-6 animate-spin", isDarkMode ? "text-[#888888]" : "text-gray-400")} />
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
