// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Platform,
  InteractionManager,
  Share,
  useWindowDimensions,
  Keyboard,
} from 'react-native'
import { AgentClient, type FileNode, type SearchResult } from '@shogo-ai/sdk/agent'
import { agentFetch } from '../../../lib/agent-fetch'
import {
  FileText,
  Folder,
  FolderOpen,
  Save,
  RefreshCw,
  Upload,
  Download,
  Trash2,
  Search,
  ChevronRight,
  ChevronDown,
  ChevronLeft,
  X,
  FolderPlus,
  FilePlus,
  Settings,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FilesBrowserPanelProps {
  projectId: string
  agentUrl: string | null
  visible: boolean
}

const WORKSPACE_FILES = [
  { id: 'AGENTS.md', label: 'Instructions', description: 'Operating rules and priorities' },
  { id: 'SOUL.md', label: 'Persona', description: 'Personality and boundaries' },
  { id: 'USER.md', label: 'User', description: 'User preferences' },
  { id: 'IDENTITY.md', label: 'Identity', description: 'Name, emoji, tagline' },
  { id: 'HEARTBEAT.md', label: 'Heartbeat', description: 'Autonomous task checklist' },
  { id: 'MEMORY.md', label: 'Memory', description: 'Long-lived facts' },
  { id: 'TOOLS.md', label: 'Tools', description: 'Tool notes and conventions' },
]

/** Equivalent to Tailwind `bottom-16` (16 × 4px = 64). Used as the base offset for the new-file dialog. */
const NEW_DIALOG_BOTTOM = 64

/** Matches 8 + depth×16px using Tailwind padding (deep trees clamp to last step). */
const TREE_INDENT_CLASSES = [
  'pl-2',
  'pl-6',
  'pl-10',
  'pl-14',
  'pl-[72px]',
  'pl-[88px]',
  'pl-[104px]',
  'pl-[120px]',
  'pl-[136px]',
  'pl-[152px]',
  'pl-[168px]',
  'pl-[184px]',
] as const

function treeIndentClass(depth: number): string {
  return TREE_INDENT_CLASSES[Math.min(depth, TREE_INDENT_CLASSES.length - 1)] ?? 'pl-2'
}

// ---------------------------------------------------------------------------
// File Tree Item
// ---------------------------------------------------------------------------

function FileTreeItem({
  entry,
  depth,
  selectedPath,
  expandedDirs,
  onSelect,
  onToggleDir,
  onNewFileInDir,
  onNewFolderInDir,
  onUploadToDir,
}: {
  entry: FileNode
  depth: number
  selectedPath: string | null
  expandedDirs: Set<string>
  onSelect: (path: string) => void
  onToggleDir: (path: string) => void
  onNewFileInDir: (dirPath: string) => void
  onNewFolderInDir: (dirPath: string) => void
  onUploadToDir: (dirPath: string) => void
}) {
  const isDir = entry.type === 'directory'
  const isExpanded = expandedDirs.has(entry.path)
  const isSelected = selectedPath === entry.path

  const ext = entry.name.split('.').pop()?.toLowerCase()

  if (isDir) {
    return (
      <>
        <View
          className={cn(
            'flex-row items-center gap-0.5 py-1 pr-2 rounded-md',
            treeIndentClass(depth),
          )}
        >
          <Pressable
            onPress={() => onToggleDir(entry.path)}
            className={cn(
              'flex-row flex-1 min-w-0 items-center gap-1.5 py-0.5 pl-0 pr-1 rounded-md',
              isSelected ? 'bg-primary/10' : 'active:bg-muted',
            )}
          >
            {isExpanded ? (
              <ChevronDown size={10} className="text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight size={10} className="text-muted-foreground shrink-0" />
            )}
            {isExpanded ? (
              <FolderOpen size={12} className="text-amber-500 shrink-0" />
            ) : (
              <Folder size={12} className="text-amber-500 shrink-0" />
            )}
            <Text
              className={cn(
                'text-xs flex-1 min-w-0',
                isSelected ? 'text-primary font-medium' : 'text-foreground',
              )}
              numberOfLines={1}
            >
              {entry.name}
            </Text>
          </Pressable>
          {isExpanded ? (
            <View className="flex-row items-center shrink-0 gap-0.5">
              <Pressable
                onPress={() => onNewFileInDir(entry.path)}
                className="p-1 rounded-md active:bg-muted"
                accessibilityLabel={`New file in ${entry.name}`}
              >
                <FilePlus size={11} className="text-muted-foreground" />
              </Pressable>
              <Pressable
                onPress={() => onNewFolderInDir(entry.path)}
                className="p-1 rounded-md active:bg-muted"
                accessibilityLabel={`New folder in ${entry.name}`}
              >
                <FolderPlus size={11} className="text-muted-foreground" />
              </Pressable>
              <Pressable
                onPress={() => onUploadToDir(entry.path)}
                className="p-1 rounded-md active:bg-muted"
                accessibilityLabel={`Upload into ${entry.name}`}
              >
                <Upload size={11} className="text-muted-foreground" />
              </Pressable>
            </View>
          ) : null}
        </View>
        {isExpanded && entry.children?.map((child) => (
          <FileTreeItem
            key={child.path}
            entry={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            expandedDirs={expandedDirs}
            onSelect={onSelect}
            onToggleDir={onToggleDir}
            onNewFileInDir={onNewFileInDir}
            onNewFolderInDir={onNewFolderInDir}
            onUploadToDir={onUploadToDir}
          />
        ))}
      </>
    )
  }

  return (
    <>
      <Pressable
        onPress={() => onSelect(entry.path)}
        className={cn(
          'flex-row items-center gap-1.5 py-1 pr-2 rounded-md active:bg-muted',
          treeIndentClass(depth),
          isSelected ? 'bg-primary/10' : '',
        )}
      >
        <View className="w-2.5 shrink-0" />
        <FileText
          size={12}
          className={cn(
            'shrink-0',
            ext === 'md' ? 'text-blue-500' :
            ext === 'csv' ? 'text-green-500' :
            'text-muted-foreground',
          )}
        />
        <Text
          className={cn(
            'text-xs flex-1 min-w-0',
            isSelected ? 'text-primary font-medium' : 'text-foreground',
          )}
          numberOfLines={1}
        >
          {entry.name}
        </Text>
        {entry.size != null && (
          <Text className="text-[10px] text-muted-foreground shrink-0">
            {formatSize(entry.size)}
          </Text>
        )}
      </Pressable>
    </>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

/** WebKit/Safari (incl. iOS) often ignore `click()` on a detached file input — keep it in the document. */
function mountWebFileInput(input: HTMLInputElement): () => void {
  input.style.cssText = 'position:fixed;left:-9999px;opacity:0;width:1px;height:1px;pointer-events:none'
  document.body.appendChild(input)
  const remove = () => {
    if (input.parentNode) input.parentNode.removeChild(input)
  }
  const fallback = window.setTimeout(remove, 120_000)
  return () => {
    window.clearTimeout(fallback)
    remove()
  }
}

// ---------------------------------------------------------------------------
// Main Panel
// ---------------------------------------------------------------------------

const NARROW_BREAKPOINT = 600

export function FilesBrowserPanel({ projectId, agentUrl, visible }: FilesBrowserPanelProps) {
  const { width } = useWindowDimensions()
  const isNarrow = width < NARROW_BREAKPOINT
  const [showEditorOnNarrow, setShowEditorOnNarrow] = useState(false)

  const client = useMemo(
    () => (agentUrl ? new AgentClient({ baseUrl: agentUrl, fetch: agentFetch }) : null),
    [agentUrl],
  )

  const [tree, setTree] = useState<FileNode[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [isWorkspaceFile, setIsWorkspaceFile] = useState(false)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [isLoadingTree, setIsLoadingTree] = useState(false)
  const [isLoadingFile, setIsLoadingFile] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [isExporting, setIsExporting] = useState(false)
  const [workspaceExpanded, setWorkspaceExpanded] = useState(true)

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)
  const [isSearching, setIsSearching] = useState(false)

  // New file/folder dialog
  const [showNewDialog, setShowNewDialog] = useState<'file' | 'folder' | null>(null)
  const [newName, setNewName] = useState('')
  const [newItemParentDir, setNewItemParentDir] = useState<string | null>(null)
  const [androidKeyboardHeight, setAndroidKeyboardHeight] = useState(0)

  const hasChanges = content !== savedContent

  // Android's soft keyboard overlaps absolutely-positioned elements even with
  // adjustResize, so we track the keyboard height and shift the dialog up manually.
  // Not needed on iOS (KeyboardAvoidingView / adjustPan handle it) or web.
  useEffect(() => {
    if (Platform.OS !== 'android' || !showNewDialog) {
      setAndroidKeyboardHeight(0)
      return
    }
    const onShow = Keyboard.addListener('keyboardDidShow', (e) =>
      setAndroidKeyboardHeight(e.endCoordinates.height),
    )
    const onHide = Keyboard.addListener('keyboardDidHide', () =>
      setAndroidKeyboardHeight(0),
    )
    return () => {
      onShow.remove()
      onHide.remove()
    }
  }, [showNewDialog])

  // -------------------------------------------------------------------------
  // Data Loading
  // -------------------------------------------------------------------------

  const loadTree = useCallback(async () => {
    if (!client) return
    setIsLoadingTree(true)
    setError(null)
    try {
      setTree(await client.getWorkspaceTree())
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoadingTree(false)
    }
  }, [client])

  const loadFile = useCallback(async (path: string) => {
    if (!client) return
    setIsLoadingFile(true)
    setError(null)
    setIsWorkspaceFile(false)
    setShowEditorOnNarrow(true)
    try {
      const text = await client.readFile(path)
      setContent(text)
      setSavedContent(text)
      setSelectedPath(path)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoadingFile(false)
    }
  }, [client])

  const loadWorkspaceFile = useCallback(async (filename: string) => {
    if (!client) return
    setIsLoadingFile(true)
    setError(null)
    setIsWorkspaceFile(true)
    setShowEditorOnNarrow(true)
    try {
      const text = await client.readWorkspaceConfigFile(filename)
      setContent(text)
      setSavedContent(text)
      setSelectedPath(filename)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoadingFile(false)
    }
  }, [client])

  useEffect(() => {
    if (visible) loadTree()
  }, [visible, loadTree])

  useEffect(() => {
    if (!visible || !client) return
    const id = setInterval(loadTree, 5000)
    return () => clearInterval(id)
  }, [visible, client, loadTree])

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const handleSave = async () => {
    if (!client || !selectedPath) return
    setIsSaving(true)
    setError(null)
    try {
      if (isWorkspaceFile) {
        await client.writeWorkspaceConfigFile(selectedPath, content)
      } else {
        await client.writeFile(selectedPath, content)
      }
      setSavedContent(content)
      if (!isWorkspaceFile) loadTree()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!client || !selectedPath) return
    try {
      await client.deleteFile(selectedPath)
      setSelectedPath(null)
      setContent('')
      setSavedContent('')
      loadTree()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleUpload = useCallback((directory: string | null = null) => {
    if (!client) return

    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.txt,.csv,.md,text/plain,text/csv,text/markdown'
      input.multiple = true
      const unmount = mountWebFileInput(input)
      input.onchange = async (e: any) => {
        const fileList = e.target?.files as FileList | undefined
        try {
          if (!fileList?.length) return
          const formData = new FormData()
          if (directory) {
            formData.append('directory', directory)
          }
          for (let i = 0; i < fileList.length; i++) {
            formData.append('files', fileList.item(i)!)
          }
          const result = await client.uploadWorkspaceFiles(formData)
          loadTree()
          if (result.count === 0) {
            setError('Upload finished but no files were saved (invalid path or unsupported name).')
          } else {
            setError(null)
          }
        } catch (err: any) {
          setError(err.message)
        } finally {
          unmount()
        }
      }
      input.click()
      return
    }

    if (Platform.OS === 'web') return

    void (async () => {
      try {
        const { getDocumentAsync } = await import('expo-document-picker')
        const result = await getDocumentAsync({
          type: ['text/plain', 'text/csv', 'text/markdown', 'text/x-markdown'],
          multiple: true,
          copyToCacheDirectory: true,
        })
        if (result.canceled || !result.assets?.length) return

        const formData = new FormData()
        if (directory) {
          formData.append('directory', directory)
        }
        for (const doc of result.assets) {
          const lower = doc.name.toLowerCase()
          if (!lower.endsWith('.txt') && !lower.endsWith('.csv') && !lower.endsWith('.md')) {
            setError(`Unsupported file: ${doc.name} (use .txt, .csv, or .md)`)
            return
          }
          const mime = doc.mimeType ?? 'text/plain'
          formData.append('files', {
            uri: doc.uri,
            name: doc.name,
            type: mime,
          } as unknown as Blob)
        }
        await client.uploadWorkspaceFiles(formData)
        loadTree()
        setError(null)
      } catch (err: any) {
        setError(err.message ?? 'Upload failed')
      }
    })()
  }, [client, loadTree])

  const handleDownload = useCallback(() => {
    if (!client || !selectedPath) return
    if (Platform.OS !== 'web' || typeof document === 'undefined') return

    const a = document.createElement('a')
    a.href = client.workspaceFileDownloadUrl(selectedPath)
    a.download = selectedPath.split('/').pop() || 'download'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [client, selectedPath])

  const handleSearch = async () => {
    if (!client || !searchQuery.trim()) return
    setIsSearching(true)
    setError(null)
    try {
      setSearchResults(await client.searchFiles(searchQuery.trim(), { limit: 15 }))
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsSearching(false)
    }
  }

  const handleCreateNew = async () => {
    if (!client || !newName.trim() || !showNewDialog) return
    try {
      const prefix = newItemParentDir ? `${newItemParentDir}/` : ''
      if (showNewDialog === 'folder') {
        await client.mkdirWorkspace(`${prefix}${newName.trim()}`)
      } else {
        const name = newName.endsWith('.txt') || newName.endsWith('.md') || newName.endsWith('.csv')
          ? newName.trim()
          : `${newName.trim()}.txt`
        const fullPath = `${prefix}${name}`
        await client.writeFile(fullPath, '')
        setSelectedPath(fullPath)
        setContent('')
        setSavedContent('')
      }
      if (newItemParentDir) {
        setExpandedDirs((prev) => new Set(prev).add(newItemParentDir))
      }
      setShowNewDialog(null)
      setNewName('')
      setNewItemParentDir(null)
      loadTree()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleExport = useCallback(async () => {
    if (!client) return
    setIsExporting(true)
    try {
      const bundle = await client.exportAgentBundle()
      const jsonStr = JSON.stringify(bundle, null, 2)

      if (Platform.OS === 'web' && typeof document !== 'undefined') {
        const blob = new Blob([jsonStr], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `agent-export-${new Date().toISOString().slice(0, 10)}.json`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      } else if (Platform.OS !== 'web') {
        const { documentDirectory, writeAsStringAsync, EncodingType } = await import('expo-file-system/legacy')
        const Sharing = await import('expo-sharing')
        const dir = documentDirectory
        if (!dir) throw new Error('Could not access app storage to save export')
        const name = `agent-export-${Date.now()}.json`
        const fileUri = `${dir}${name}`
        await writeAsStringAsync(fileUri, jsonStr, { encoding: EncodingType.UTF8 })

        // Let the active screen settle so Android/iOS can present the share sheet reliably.
        await new Promise<void>((resolve) => {
          InteractionManager.runAfterInteractions(() => resolve())
        })

        const shareOptions = {
          // Android: strict application/json often yields an empty chooser; text/plain still sends the .json file.
          mimeType: Platform.OS === 'android' ? 'text/plain' : 'application/json',
          UTI: 'public.json' as const,
          dialogTitle: 'Export Agent',
        }

        try {
          await Sharing.shareAsync(fileUri, shareOptions)
        } catch (shareErr: unknown) {
          if (Platform.OS === 'ios') {
            await Share.share({
              url: fileUri,
              title: 'Export Agent',
            })
          } else {
            throw shareErr
          }
        }
      }
      setError(null)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsExporting(false)
    }
  }, [client])

  const handleImport = useCallback(() => {
    if (!client) return

    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.json,application/json'
      const unmount = mountWebFileInput(input)
      input.onchange = async (e: any) => {
        const file = e.target?.files?.[0] as File | undefined
        try {
          if (!file) return
          const text = await file.text()
          const bundle = JSON.parse(text)
          await client.importAgentBundle(bundle)
          if (isWorkspaceFile && selectedPath) {
            loadWorkspaceFile(selectedPath)
          }
          setError(null)
        } catch (err: any) {
          setError(err.message || 'Failed to import agent configuration')
        } finally {
          unmount()
        }
      }
      input.click()
      return
    }

    if (Platform.OS === 'web') return

    void (async () => {
      try {
        const { getDocumentAsync } = await import('expo-document-picker')
        const result = await getDocumentAsync({
          type: ['application/json'],
          copyToCacheDirectory: true,
          multiple: false,
        })
        if (result.canceled || !result.assets?.[0]) return

        const { readAsStringAsync } = await import('expo-file-system/legacy')
        const text = await readAsStringAsync(result.assets[0].uri)
        const bundle = JSON.parse(text)
        await client.importAgentBundle(bundle)
        if (isWorkspaceFile && selectedPath) {
          loadWorkspaceFile(selectedPath)
        }
        loadTree()
        setError(null)
      } catch (err: any) {
        setError(err.message || 'Failed to import agent configuration')
      }
    })()
  }, [client, isWorkspaceFile, selectedPath, loadWorkspaceFile, loadTree])

  const toggleDir = (path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  if (!visible) return null

  const showSidebar = !isNarrow || !showEditorOnNarrow
  const showEditor = !isNarrow || showEditorOnNarrow

  return (
    <View className="absolute inset-0 flex-row">
      {/* Sidebar */}
      <View
        className={cn(
          'border-r border-border bg-muted/30 flex-col',
          isNarrow ? 'flex-1' : 'w-56',
          !showSidebar && 'hidden',
        )}
      >
        {/* Search bar */}
        <View className="p-2 border-b border-border">
          <View className="flex-row items-center bg-background border border-border rounded-md px-2">
            <Search size={12} className="text-muted-foreground" />
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              onSubmitEditing={handleSearch}
              placeholder="Search files..."
              className="flex-1 text-xs py-1.5 px-1.5 text-foreground placeholder:text-muted-foreground"
              autoCapitalize="none"
              returnKeyType="search"
            />
            {searchQuery ? (
              <Pressable onPress={() => { setSearchQuery(''); setSearchResults(null) }}>
                <X size={12} className="text-muted-foreground" />
              </Pressable>
            ) : null}
          </View>
        </View>

        {/* File tree or search results */}
        <ScrollView className="flex-1">
          {searchResults ? (
            <View className="p-2">
              <View className="flex-row items-center justify-between mb-1">
                <Text className="text-xs font-medium text-muted-foreground">
                  {searchResults.length} result{searchResults.length !== 1 ? 's' : ''}
                </Text>
                <Pressable onPress={() => setSearchResults(null)}>
                  <Text className="text-[10px] text-primary">Clear</Text>
                </Pressable>
              </View>
              {isSearching ? (
                <ActivityIndicator size="small" />
              ) : (
                searchResults.map((r, i) => (
                  <Pressable
                    key={`${r.path}-${i}`}
                    onPress={() => { loadFile(r.path); setSearchResults(null) }}
                    className="py-1.5 px-2 rounded-md active:bg-muted border-b border-border/50"
                  >
                    <View className="flex-row items-center gap-1">
                      <FileText size={10} className="text-muted-foreground" />
                      <Text className="text-xs font-medium text-foreground" numberOfLines={1}>
                        {r.path}
                      </Text>
                      <Text className="text-[10px] text-muted-foreground ml-auto">
                        {r.matchType}
                      </Text>
                    </View>
                    <Text className="text-[10px] text-muted-foreground mt-0.5" numberOfLines={2}>
                      {r.chunk.slice(0, 120)}
                    </Text>
                  </Pressable>
                ))
              )}
            </View>
          ) : isLoadingTree ? (
            <View className="flex-1 items-center justify-center p-4">
              <ActivityIndicator size="small" />
            </View>
          ) : (
            <View className="p-1">
              {/* Workspace config files */}
              <Pressable
                onPress={() => setWorkspaceExpanded((v) => !v)}
                className="flex-row items-center gap-1 px-2 py-1"
              >
                {workspaceExpanded ? (
                  <ChevronDown size={10} className="text-muted-foreground" />
                ) : (
                  <ChevronRight size={10} className="text-muted-foreground" />
                )}
                <Settings size={10} className="text-muted-foreground" />
                <Text className="text-[10px] font-medium text-muted-foreground">
                  WORKSPACE
                </Text>
              </Pressable>
              {workspaceExpanded && WORKSPACE_FILES.map((file) => (
                <Pressable
                  key={file.id}
                  onPress={() => loadWorkspaceFile(file.id)}
                  className={cn(
                    'pl-6 pr-2 py-1 rounded-md',
                    isWorkspaceFile && selectedPath === file.id ? 'bg-primary/10' : 'active:bg-muted',
                  )}
                >
                  <View className="flex-row items-center gap-1.5">
                    <FileText
                      size={12}
                      className={isWorkspaceFile && selectedPath === file.id ? 'text-primary' : 'text-blue-500'}
                    />
                    <Text
                      className={cn(
                        'text-xs',
                        isWorkspaceFile && selectedPath === file.id
                          ? 'text-primary font-medium'
                          : 'text-foreground',
                      )}
                      numberOfLines={1}
                    >
                      {file.label}
                    </Text>
                  </View>
                  <Text className="text-[10px] text-muted-foreground ml-[18px]" numberOfLines={1}>
                    {file.description}
                  </Text>
                </Pressable>
              ))}

              {/* General file tree */}
              <Text className="text-[10px] font-medium text-muted-foreground px-2 py-1 mt-2">
                FILES
              </Text>
              {tree.length === 0 ? (
                <Text className="text-xs text-muted-foreground px-2 py-2 italic">
                  No files yet. Upload or create one.
                </Text>
              ) : (
                tree.map((entry) => (
                  <FileTreeItem
                    key={entry.path}
                    entry={entry}
                    depth={0}
                    selectedPath={!isWorkspaceFile ? selectedPath : null}
                    expandedDirs={expandedDirs}
                    onSelect={loadFile}
                    onToggleDir={toggleDir}
                    onNewFileInDir={(dirPath) => {
                      setNewItemParentDir(dirPath)
                      setShowNewDialog('file')
                      setNewName('')
                    }}
                    onNewFolderInDir={(dirPath) => {
                      setNewItemParentDir(dirPath)
                      setShowNewDialog('folder')
                      setNewName('')
                    }}
                    onUploadToDir={(dirPath) => {
                      handleUpload(dirPath)
                    }}
                  />
                ))
              )}
            </View>
          )}
        </ScrollView>

        {/* Bottom actions */}
        <View className="p-2 border-t border-border gap-1">
          <View className="flex-row gap-1">
            <Pressable
              onPress={() => {
                setNewItemParentDir(null)
                setShowNewDialog('file')
                setNewName('')
              }}
              className="flex-1 flex-row items-center justify-center gap-1 px-2 py-1.5 rounded-md active:bg-muted border border-border"
            >
              <FilePlus size={12} className="text-muted-foreground" />
              <Text className="text-[10px] text-muted-foreground">New File</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setNewItemParentDir(null)
                setShowNewDialog('folder')
                setNewName('')
              }}
              className="flex-1 flex-row items-center justify-center gap-1 px-2 py-1.5 rounded-md active:bg-muted border border-border"
            >
              <FolderPlus size={12} className="text-muted-foreground" />
              <Text className="text-[10px] text-muted-foreground">New Folder</Text>
            </Pressable>
          </View>
          <Pressable
            onPress={() => handleUpload(null)}
            className="flex-row items-center gap-1.5 px-2 py-1.5 rounded-md active:bg-muted"
          >
            <Upload size={12} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">Upload Files</Text>
          </Pressable>
          <View className="border-t border-border mt-1 pt-1 gap-1">
            <Pressable
              onPress={handleExport}
              disabled={isExporting}
              className="flex-row items-center gap-1.5 px-2 py-1.5 rounded-md active:bg-muted"
            >
              <Download size={12} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">
                {isExporting ? 'Exporting...' : 'Export Agent'}
              </Text>
            </Pressable>
            <Pressable
              onPress={handleImport}
              className="flex-row items-center gap-1.5 px-2 py-1.5 rounded-md active:bg-muted"
            >
              <Upload size={12} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">Import Agent</Text>
            </Pressable>
          </View>
        </View>

        {/* New file/folder dialog */}
        {showNewDialog && (
          <View
            className="absolute left-2 right-2 bg-background border border-border rounded-lg p-3 shadow-lg z-10"
            style={{ bottom: NEW_DIALOG_BOTTOM + androidKeyboardHeight }}
          >
            <Text className="text-xs font-medium text-foreground mb-2">
              {newItemParentDir
                ? `New ${showNewDialog === 'file' ? 'File' : 'Folder'} in ${newItemParentDir}/`
                : `New ${showNewDialog === 'file' ? 'File' : 'Folder'}`}
            </Text>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              placeholder={showNewDialog === 'file' ? 'filename.txt' : 'folder-name'}
              className="text-xs border border-border rounded-md px-2 py-1.5 mb-2 text-foreground bg-muted/30 placeholder:text-muted-foreground"
              autoCapitalize="none"
              autoFocus
              onSubmitEditing={handleCreateNew}
            />
            <View className="flex-row gap-2">
              <Pressable
                onPress={() => {
                  setShowNewDialog(null)
                  setNewItemParentDir(null)
                  setNewName('')
                }}
                className="flex-1 items-center py-1.5 rounded-md border border-border active:bg-muted"
              >
                <Text className="text-xs text-muted-foreground">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleCreateNew}
                className="flex-1 items-center py-1.5 rounded-md bg-primary active:bg-primary/80"
              >
                <Text className="text-xs text-primary-foreground">Create</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>

      {/* Editor area */}
      <View className={cn('flex-1 flex-col', !showEditor && 'hidden')}>
        {selectedPath ? (
          <>
            {/* Toolbar */}
            <View className="px-3 py-2 border-b border-border flex-row items-center gap-2">
              {isNarrow && (
                <Pressable
                  onPress={() => setShowEditorOnNarrow(false)}
                  className="p-1 rounded-md active:bg-muted mr-1"
                >
                  <ChevronLeft size={18} className="text-foreground" />
                </Pressable>
              )}
              <FileText size={14} className="text-muted-foreground" />
              <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                {isWorkspaceFile
                  ? WORKSPACE_FILES.find((f) => f.id === selectedPath)?.label ?? selectedPath
                  : selectedPath}
              </Text>
              {isWorkspaceFile && (
                <Text className="text-[10px] text-muted-foreground">{selectedPath}</Text>
              )}
              {hasChanges && <Text className="text-xs text-amber-500">unsaved</Text>}

              <View className="ml-auto flex-row items-center gap-1">
                {!isWorkspaceFile && (
                  <>
                    <Pressable
                      onPress={handleDownload}
                      className="p-1.5 rounded-md active:bg-muted"
                    >
                      <Download size={14} className="text-muted-foreground" />
                    </Pressable>
                    <Pressable
                      onPress={handleDelete}
                      className="p-1.5 rounded-md active:bg-muted"
                    >
                      <Trash2 size={14} className="text-destructive" />
                    </Pressable>
                  </>
                )}
                <Pressable
                  onPress={() => {
                    loadTree()
                    if (selectedPath) {
                      isWorkspaceFile ? loadWorkspaceFile(selectedPath) : loadFile(selectedPath)
                    }
                  }}
                  className="p-1.5 rounded-md active:bg-muted"
                >
                  <RefreshCw size={14} className="text-muted-foreground" />
                </Pressable>
                <Pressable
                  onPress={handleSave}
                  disabled={!hasChanges || isSaving}
                  className={cn(
                    'flex-row items-center gap-1 px-2 py-1 rounded-md bg-primary active:bg-primary/80',
                    (!hasChanges || isSaving) && 'opacity-50',
                  )}
                >
                  <Save size={12} className="text-primary-foreground" />
                  <Text className="text-xs text-primary-foreground">
                    {isSaving ? 'Saving...' : 'Save'}
                  </Text>
                </Pressable>
              </View>
            </View>

            {error && (
              <View className="px-3 py-2 bg-destructive/10">
                <Text className="text-xs text-destructive">{error}</Text>
              </View>
            )}

            {isLoadingFile ? (
              <View className="flex-1 items-center justify-center">
                <ActivityIndicator size="small" />
              </View>
            ) : (
              <TextInput
                value={content}
                onChangeText={setContent}
                className="flex-1 p-4 font-mono text-sm bg-background text-foreground placeholder:text-muted-foreground"
                placeholder="Edit file..."
                multiline
                textAlignVertical="top"
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
              />
            )}
          </>
        ) : (
          <View className="flex-1 items-center justify-center gap-3">
            <FileText size={40} className="text-muted-foreground/50" />
            <Text className="text-sm text-muted-foreground">
              Select a file to view or edit
            </Text>
            <Text className="text-xs text-muted-foreground text-center px-8">
              Upload .txt, .csv, or .md files. Your agent can search across all files using RAG.
            </Text>
          </View>
        )}
      </View>
    </View>
  )
}
