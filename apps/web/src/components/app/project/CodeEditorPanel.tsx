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
 * - LSP integration for full IntelliSense (via tsserver)
 * - Automatic Type Acquisition (ATA) from CDN as fallback
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import Editor, { type Monaco } from "@monaco-editor/react"
import { Loader2, FileText, Folder, FolderOpen, ChevronRight, ChevronDown, RefreshCw, Cloud, CloudOff } from "lucide-react"
import { cn } from "@/lib/utils"
import { getLSPClient, type MonacoLSPClient } from "@/lib/lsp-client"

// =============================================================================
// Automatic Type Acquisition (ATA) System
// =============================================================================
// Fetches type definitions from CDN for npm packages found in import statements.
// This enables IntelliSense for popular packages like React, TanStack, etc.
// =============================================================================

/** Cache for fetched type definitions to avoid repeated network requests */
const typeCache = new Map<string, string>()

/** Set of packages currently being fetched (to avoid duplicate requests) */
const fetchingTypes = new Set<string>()

/** Set of packages that failed to fetch (to avoid retrying) */
const failedTypes = new Set<string>()

/** 
 * API proxy URL for fetching types - avoids CORS issues with CDNs
 * Usage: /api/types-proxy?url=<encoded-url>
 */
const TYPE_PROXY_URL = '/api/types-proxy'

/** CDN URLs for fetching types */
const TYPE_CDN_URLS = [
  // jsdelivr for @types packages (most reliable)
  (pkg: string) => `https://cdn.jsdelivr.net/npm/@types/${pkg.replace('@', '').replace('/', '__')}/index.d.ts`,
  // unpkg for @types packages
  (pkg: string) => `https://unpkg.com/@types/${pkg.replace('@', '').replace('/', '__')}/index.d.ts`,
]

/**
 * Extract npm package names from import statements in code.
 * Handles various import syntaxes:
 * - import x from 'package'
 * - import { x } from 'package'
 * - import 'package'
 * - import type { x } from 'package'
 */
function extractImports(code: string): string[] {
  const importRegex = /import\s+(?:type\s+)?(?:[\w\s{},*]+\s+from\s+)?['"]([^'"./][^'"]*)['"]/g
  const packages = new Set<string>()
  let match

  while ((match = importRegex.exec(code)) !== null) {
    const pkg = match[1]
    // Get the base package name (e.g., '@tanstack/react-router' -> '@tanstack/react-router')
    // For scoped packages, include the scope
    if (pkg.startsWith('@')) {
      // Scoped package: @scope/name or @scope/name/subpath
      const parts = pkg.split('/')
      if (parts.length >= 2) {
        packages.add(`${parts[0]}/${parts[1]}`)
      }
    } else {
      // Regular package: name or name/subpath
      const basePkg = pkg.split('/')[0]
      packages.add(basePkg)
    }
  }

  return Array.from(packages)
}

/**
 * Fetch type definitions for a package via the API proxy (avoids CORS).
 * Caches successful results.
 */
async function fetchTypesForPackage(packageName: string): Promise<string | null> {
  // Check cache first
  if (typeCache.has(packageName)) {
    return typeCache.get(packageName)!
  }

  // Skip if already fetching or previously failed
  if (fetchingTypes.has(packageName) || failedTypes.has(packageName)) {
    return null
  }

  fetchingTypes.add(packageName)

  // Helper to validate type definition content
  const isValidTypes = (content: string) => 
    content.includes('declare') || content.includes('export') || content.includes('interface')

  // Try each CDN URL via the proxy
  for (const urlFn of TYPE_CDN_URLS) {
    try {
      const cdnUrl = urlFn(packageName)
      const proxyUrl = `${TYPE_PROXY_URL}?url=${encodeURIComponent(cdnUrl)}`
      
      const response = await fetch(proxyUrl, { 
        signal: AbortSignal.timeout(5000) // 5 second timeout
      })
      
      if (response.ok) {
        const types = await response.text()
        if (isValidTypes(types)) {
          typeCache.set(packageName, types)
          fetchingTypes.delete(packageName)
          console.log(`[ATA] Loaded types for ${packageName} via proxy`)
          return types
        }
      }
    } catch {
      // Try next URL
    }
  }

  // Mark as failed so we don't retry
  failedTypes.add(packageName)
  fetchingTypes.delete(packageName)
  console.log(`[ATA] No types found for ${packageName}`)
  return null
}

/**
 * Load types for all imports in the given code.
 * Returns a map of package name to type definitions.
 */
async function loadTypesForCode(code: string, monaco: Monaco): Promise<void> {
  const packages = extractImports(code)
  
  // Skip packages we've already loaded or that are relative imports
  const packagesToLoad = packages.filter(pkg => 
    !typeCache.has(pkg) && 
    !failedTypes.has(pkg) && 
    !fetchingTypes.has(pkg)
  )

  if (packagesToLoad.length === 0) return

  // Fetch types in parallel (with concurrency limit)
  const results = await Promise.allSettled(
    packagesToLoad.map(pkg => fetchTypesForPackage(pkg))
  )

  // Add successfully fetched types to Monaco
  packagesToLoad.forEach((pkg, index) => {
    const result = results[index]
    if (result.status === 'fulfilled' && result.value) {
      const typePath = `file:///node_modules/@types/${pkg.replace('@', '').replace('/', '__')}/index.d.ts`
      monaco.languages.typescript.typescriptDefaults.addExtraLib(result.value, typePath)
      monaco.languages.typescript.javascriptDefaults.addExtraLib(result.value, typePath)
    }
  })
}

// Store Monaco instance for ATA
let monacoInstance: Monaco | null = null

/**
 * Configure Monaco Editor when it mounts.
 * This ensures TypeScript/JavaScript settings are correct for JSX/TSX files.
 */
function handleEditorWillMount(monaco: Monaco) {
  monacoInstance = monaco

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
    // Enable strict mode for better IntelliSense
    strict: true,
    // Allow synthetic default imports (import React from 'react')
    allowSyntheticDefaultImports: true,
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
    allowSyntheticDefaultImports: true,
  })

  // Disable semantic validation - ATA can't fetch all types (many packages bundle their own)
  // This prevents red squiggles for missing types while still providing:
  // - Syntax highlighting
  // - Syntax error detection
  // - IntelliSense for packages with @types available (react, react-dom, etc.)
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  })

  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  })

  // Pre-load common React types immediately (these are almost always needed)
  loadCommonTypes(monaco)
}

/**
 * Pre-load type definitions for commonly used packages.
 * This provides immediate IntelliSense without waiting for code analysis.
 */
async function loadCommonTypes(monaco: Monaco) {
  const commonPackages = ['react', 'react-dom']
  
  for (const pkg of commonPackages) {
    const types = await fetchTypesForPackage(pkg)
    if (types) {
      const typePath = `file:///node_modules/@types/${pkg}/index.d.ts`
      monaco.languages.typescript.typescriptDefaults.addExtraLib(types, typePath)
      monaco.languages.typescript.javascriptDefaults.addExtraLib(types, typePath)
    }
  }
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
 * Handles deduplication when API returns both directories and their contents.
 */
function buildFileTree(files: FileInfo[]): TreeNode[] {
  const root: TreeNode[] = []
  const directories: Map<string, TreeNode> = new Map()
  const nodesByPath: Map<string, TreeNode> = new Map() // Track all nodes by path

  // Sort files: directories first, then alphabetically
  const sortedFiles = [...files].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.path.localeCompare(b.path)
  })

  for (const file of sortedFiles) {
    // Skip if this exact path was already added (deduplication)
    if (nodesByPath.has(file.path)) continue
    
    const parts = file.path.split('/')
    let currentPath = ''
    let currentLevel = root

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLast = i === parts.length - 1
      currentPath = currentPath ? `${currentPath}/${part}` : part

      if (isLast) {
        // Check if a directory with this path was already created as an intermediate
        const existingDir = directories.get(file.path)
        if (existingDir) {
          // Update the existing directory node with file info (extension, etc.)
          existingDir.extension = file.extension
        } else {
          // Add new node
          const newNode: TreeNode = {
            name: part,
            path: file.path,
            type: file.type,
            extension: file.extension,
            children: file.type === 'directory' ? [] : undefined,
            expanded: false,
          }
          currentLevel.push(newNode)
          nodesByPath.set(file.path, newNode)
          if (file.type === 'directory') {
            directories.set(file.path, newNode)
          }
        }
      } else {
        let dir = directories.get(currentPath)
        if (!dir) {
          // Check if a file node with this path already exists - convert it to directory
          const existingNode = nodesByPath.get(currentPath)
          if (existingNode) {
            // Convert existing file node to directory
            existingNode.type = 'directory'
            existingNode.children = existingNode.children || []
            existingNode.expanded = true
            dir = existingNode
            directories.set(currentPath, dir)
          } else {
            // Create new intermediate directory
            dir = {
              name: part,
              path: currentPath,
              type: 'directory',
              children: [],
              expanded: true,
            }
            currentLevel.push(dir)
            directories.set(currentPath, dir)
            nodesByPath.set(currentPath, dir)
          }
        }
        currentLevel = dir.children!
      }
    }
  }

  return root
}

/**
 * Get Monaco language from file extension.
 * Accepts either an extension (e.g., ".tsx") or a full file path.
 */
function getMonacoLanguage(extensionOrPath?: string): string {
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
  
  if (!extensionOrPath) return 'plaintext'
  
  // If it's already an extension (starts with .), use it directly
  if (extensionOrPath.startsWith('.')) {
    return languageMap[extensionOrPath] || 'plaintext'
  }
  
  // Extract extension from file path
  const lastDot = extensionOrPath.lastIndexOf('.')
  if (lastDot === -1) return 'plaintext'
  
  const ext = extensionOrPath.slice(lastDot)
  return languageMap[ext] || 'plaintext'
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

  // LSP client for IntelliSense
  const lspClientRef = useRef<MonacoLSPClient | null>(null)
  const [lspConnected, setLspConnected] = useState(false)

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
  // autoSelect: only auto-select a file on initial load, not on refresh
  const loadFiles = useCallback(async (autoSelect = true) => {
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
      // Expand all top-level directories by default (src, tests, public, prisma, etc.)
      const topLevelDirs = (data.files || [])
        .filter((f: FileInfo) => f.type === 'directory' && !f.path.includes('/'))
        .map((f: FileInfo) => f.path)
      setExpandedDirs(new Set(topLevelDirs))

      // Auto-select App.tsx or first file (only on initial load)
      if (autoSelect) {
        const appFile = data.files?.find((f: FileInfo) =>
          f.type === 'file' && f.path.endsWith('App.tsx')
        )
        const firstFile = appFile || data.files?.find((f: FileInfo) => f.type === 'file')
        if (firstFile) {
          setSelectedFile(firstFile.path)
        }
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

      // Trigger Automatic Type Acquisition for TypeScript/JavaScript files
      const isTypeScriptFile = filePath.endsWith('.ts') || filePath.endsWith('.tsx') || 
                               filePath.endsWith('.js') || filePath.endsWith('.jsx')
      if (isTypeScriptFile && monacoInstance && content) {
        // Load types in background (don't block file display)
        loadTypesForCode(content, monacoInstance).catch(err => {
          console.warn('[ATA] Failed to load types:', err)
        })
      }
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
  // Use a ref to track selectedFile so we don't re-run when user clicks a file
  const selectedFileRef = useRef(selectedFile)
  selectedFileRef.current = selectedFile

  useEffect(() => {
    if (refreshTrigger !== undefined && refreshTrigger > 0) {
      console.log('[CodeEditorPanel] 🔄 Refresh triggered by agent file modifications')
      // Pass false to prevent auto-selecting a file on refresh (preserves user selection)
      loadFiles(false)
      // Also reload the currently selected file content (using ref to avoid dependency)
      if (selectedFileRef.current) {
        loadFileContent(selectedFileRef.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedFile tracked via ref
  }, [refreshTrigger, loadFiles, loadFileContent])

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

  // Ref for debounced type loading
  const typeLoadTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Handle editor content changes with debounced auto-save and type loading
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

    // Debounced type loading for new imports (longer delay to avoid excessive fetches)
    if (typeLoadTimeoutRef.current) {
      clearTimeout(typeLoadTimeoutRef.current)
    }
    if (monacoInstance && newContent) {
      typeLoadTimeoutRef.current = setTimeout(() => {
        loadTypesForCode(newContent, monacoInstance!).catch(err => {
          console.warn('[ATA] Failed to load types:', err)
        })
      }, 2000) // 2 second delay for type loading
    }
  }, [originalContent, saveFile])

  // Cleanup timeouts and LSP on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
      if (typeLoadTimeoutRef.current) {
        clearTimeout(typeLoadTimeoutRef.current)
      }
      // Disconnect LSP client
      if (lspClientRef.current) {
        lspClientRef.current.disconnect()
        lspClientRef.current = null
      }
    }
  }, [])

  // Connect to LSP server when Monaco is ready
  useEffect(() => {
    if (!monacoInstance || !projectId) return

    // Get or create LSP client for this project
    const client = getLSPClient(projectId)
    lspClientRef.current = client

    // Connect to the LSP server
    client.connect(monacoInstance)
      .then(() => {
        console.log('[CodeEditorPanel] LSP connected for project:', projectId)
        setLspConnected(true)
      })
      .catch((error) => {
        console.warn('[CodeEditorPanel] LSP connection failed, using ATA fallback:', error.message)
        setLspConnected(false)
      })

    return () => {
      // Don't disconnect on every effect re-run, only on unmount (handled above)
    }
  }, [projectId])

  // Notify LSP when file content changes
  useEffect(() => {
    if (!lspClientRef.current || !selectedFile || !lspConnected) return

    const uri = `file://${selectedFile}`
    const isTypeScriptFile = selectedFile.endsWith('.ts') || selectedFile.endsWith('.tsx') || 
                             selectedFile.endsWith('.js') || selectedFile.endsWith('.jsx')
    
    if (isTypeScriptFile && fileContent) {
      const languageId = selectedFile.endsWith('.tsx') || selectedFile.endsWith('.jsx') 
        ? 'typescriptreact' 
        : selectedFile.endsWith('.ts') 
          ? 'typescript' 
          : 'javascript'
      
      // Notify LSP of document open/change
      lspClientRef.current.didOpenTextDocument(uri, languageId, fileContent)
    }
  }, [selectedFile, fileContent, lspConnected])

  // Get current file extension for language detection
  // Use file's extension if available, otherwise extract from the file path
  const currentExtension = selectedFile
    ? files.find(f => f.path === selectedFile)?.extension
    : undefined
  const language = getMonacoLanguage(currentExtension || selectedFile || undefined)

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
            onClick={() => loadFiles(false)}
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
              language={language}
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
