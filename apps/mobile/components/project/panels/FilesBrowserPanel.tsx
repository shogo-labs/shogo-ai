// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Platform,
  useWindowDimensions,
} from 'react-native'
import {
  FileText,
  Folder,
  FolderOpen,
  Save,
  RefreshCw,
  Upload,
  Download,
  Plus,
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

interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modified?: number
  children?: FileEntry[]
}

interface SearchResult {
  path: string
  chunk: string
  score: number
  lines: string
  matchType: string
}

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
}: {
  entry: FileEntry
  depth: number
  selectedPath: string | null
  expandedDirs: Set<string>
  onSelect: (path: string) => void
  onToggleDir: (path: string) => void
}) {
  const isDir = entry.type === 'directory'
  const isExpanded = expandedDirs.has(entry.path)
  const isSelected = selectedPath === entry.path

  const ext = entry.name.split('.').pop()?.toLowerCase()

  return (
    <>
      <Pressable
        onPress={() => {
          if (isDir) onToggleDir(entry.path)
          else onSelect(entry.path)
        }}
        className={cn(
          'flex-row items-center gap-1.5 py-1 px-2 rounded-md',
          isSelected ? 'bg-primary/10' : 'active:bg-muted',
        )}
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        {isDir ? (
          <>
            {isExpanded ? (
              <ChevronDown size={10} className="text-muted-foreground" />
            ) : (
              <ChevronRight size={10} className="text-muted-foreground" />
            )}
            {isExpanded ? (
              <FolderOpen size={12} className="text-amber-500" />
            ) : (
              <Folder size={12} className="text-amber-500" />
            )}
          </>
        ) : (
          <>
            <View style={{ width: 10 }} />
            <FileText
              size={12}
              className={cn(
                ext === 'md' ? 'text-blue-500' :
                ext === 'csv' ? 'text-green-500' :
                'text-muted-foreground',
              )}
            />
          </>
        )}
        <Text
          className={cn(
            'text-xs flex-1',
            isSelected ? 'text-primary font-medium' : 'text-foreground',
          )}
          numberOfLines={1}
        >
          {entry.name}
        </Text>
        {!isDir && entry.size != null && (
          <Text className="text-[10px] text-muted-foreground">
            {formatSize(entry.size)}
          </Text>
        )}
      </Pressable>
      {isDir && isExpanded && entry.children?.map((child) => (
        <FileTreeItem
          key={child.path}
          entry={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          expandedDirs={expandedDirs}
          onSelect={onSelect}
          onToggleDir={onToggleDir}
        />
      ))}
    </>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

// ---------------------------------------------------------------------------
// Main Panel
// ---------------------------------------------------------------------------

const NARROW_BREAKPOINT = 600

export function FilesBrowserPanel({ projectId, agentUrl, visible }: FilesBrowserPanelProps) {
  const { width } = useWindowDimensions()
  const isNarrow = width < NARROW_BREAKPOINT
  const [showEditorOnNarrow, setShowEditorOnNarrow] = useState(false)

  const [tree, setTree] = useState<FileEntry[]>([])
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

  const hasChanges = content !== savedContent

  // -------------------------------------------------------------------------
  // Data Loading
  // -------------------------------------------------------------------------

  const loadTree = useCallback(async () => {
    if (!agentUrl) return
    setIsLoadingTree(true)
    setError(null)
    try {
      const res = await fetch(`${agentUrl}/agent/workspace/tree`)
      if (!res.ok) throw new Error('Failed to load files')
      const data = await res.json()
      setTree(data.tree || [])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoadingTree(false)
    }
  }, [agentUrl])

  const loadFile = useCallback(async (path: string) => {
    if (!agentUrl) return
    setIsLoadingFile(true)
    setError(null)
    setIsWorkspaceFile(false)
    setShowEditorOnNarrow(true)
    try {
      const res = await fetch(`${agentUrl}/agent/workspace/files/${encodeURIComponent(path)}`)
      if (!res.ok) throw new Error('Failed to load file')
      const data = await res.json()
      setContent(data.content || '')
      setSavedContent(data.content || '')
      setSelectedPath(path)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoadingFile(false)
    }
  }, [agentUrl])

  const loadWorkspaceFile = useCallback(async (filename: string) => {
    if (!agentUrl) return
    setIsLoadingFile(true)
    setError(null)
    setIsWorkspaceFile(true)
    setShowEditorOnNarrow(true)
    try {
      const res = await fetch(`${agentUrl}/agent/files/${filename}`)
      if (!res.ok) throw new Error('Failed to load file')
      const data = await res.json()
      setContent(data.content || '')
      setSavedContent(data.content || '')
      setSelectedPath(filename)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoadingFile(false)
    }
  }, [agentUrl])

  useEffect(() => {
    if (visible) loadTree()
  }, [visible, loadTree])

  useEffect(() => {
    if (!visible || !agentUrl) return
    const id = setInterval(loadTree, 5000)
    return () => clearInterval(id)
  }, [visible, agentUrl, loadTree])

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const handleSave = async () => {
    if (!agentUrl || !selectedPath) return
    setIsSaving(true)
    setError(null)
    try {
      const url = isWorkspaceFile
        ? `${agentUrl}/agent/files/${selectedPath}`
        : `${agentUrl}/agent/workspace/files/${encodeURIComponent(selectedPath)}`
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      if (!res.ok) throw new Error('Failed to save')
      setSavedContent(content)
      if (!isWorkspaceFile) loadTree()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!agentUrl || !selectedPath) return
    try {
      const res = await fetch(`${agentUrl}/agent/workspace/files/${encodeURIComponent(selectedPath)}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error('Failed to delete')
      setSelectedPath(null)
      setContent('')
      setSavedContent('')
      loadTree()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleUpload = useCallback(() => {
    if (!agentUrl) return
    if (Platform.OS !== 'web' || typeof document === 'undefined') return

    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.txt,.csv,.md'
    input.multiple = true
    input.onchange = async (e: any) => {
      const files = e.target?.files
      if (!files?.length) return
      try {
        const formData = new FormData()
        for (const file of files) {
          formData.append('files', file)
        }
        const res = await fetch(`${agentUrl}/agent/workspace/upload`, {
          method: 'POST',
          body: formData,
        })
        if (!res.ok) throw new Error('Upload failed')
        loadTree()
        setError(null)
      } catch (err: any) {
        setError(err.message)
      }
    }
    input.click()
  }, [agentUrl, loadTree])

  const handleDownload = useCallback(() => {
    if (!agentUrl || !selectedPath) return
    if (Platform.OS !== 'web' || typeof document === 'undefined') return

    const a = document.createElement('a')
    a.href = `${agentUrl}/agent/workspace/download/${encodeURIComponent(selectedPath)}`
    a.download = selectedPath.split('/').pop() || 'download'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [agentUrl, selectedPath])

  const handleSearch = async () => {
    if (!agentUrl || !searchQuery.trim()) return
    setIsSearching(true)
    setError(null)
    try {
      const res = await fetch(`${agentUrl}/agent/workspace/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery, limit: 15 }),
      })
      if (!res.ok) throw new Error('Search failed')
      const data = await res.json()
      setSearchResults(data.results || [])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsSearching(false)
    }
  }

  const handleCreateNew = async () => {
    if (!agentUrl || !newName.trim() || !showNewDialog) return
    try {
      if (showNewDialog === 'folder') {
        const res = await fetch(`${agentUrl}/agent/workspace/mkdir`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: newName }),
        })
        if (!res.ok) throw new Error('Failed to create folder')
      } else {
        const path = newName.endsWith('.txt') || newName.endsWith('.md') || newName.endsWith('.csv')
          ? newName : `${newName}.txt`
        const res = await fetch(`${agentUrl}/agent/workspace/files/${encodeURIComponent(path)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: '' }),
        })
        if (!res.ok) throw new Error('Failed to create file')
        setSelectedPath(path)
        setContent('')
        setSavedContent('')
      }
      setShowNewDialog(null)
      setNewName('')
      loadTree()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleExport = useCallback(async () => {
    if (!agentUrl) return
    setIsExporting(true)
    try {
      const res = await fetch(`${agentUrl}/agent/export`)
      if (!res.ok) throw new Error('Failed to export')
      const bundle = await res.json()
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
      }
      setError(null)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsExporting(false)
    }
  }, [agentUrl])

  const handleImport = useCallback(() => {
    if (!agentUrl) return
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.json'
      input.onchange = async (e: any) => {
        const file = e.target?.files?.[0]
        if (!file) return
        try {
          const text = await file.text()
          const bundle = JSON.parse(text)
          const res = await fetch(`${agentUrl}/agent/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bundle),
          })
          if (!res.ok) throw new Error('Failed to import agent')
          if (isWorkspaceFile && selectedPath) {
            loadWorkspaceFile(selectedPath)
          }
          setError(null)
        } catch (err: any) {
          setError(err.message || 'Failed to import agent configuration')
        }
      }
      input.click()
    }
  }, [agentUrl, isWorkspaceFile, selectedPath, loadWorkspaceFile])

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
    <View className="absolute inset-0 flex-row" style={{ display: visible ? 'flex' : 'none' }}>
      {/* Sidebar */}
      <View className={cn('border-r border-border bg-muted/30 flex-col', isNarrow ? 'flex-1' : 'w-56')} style={!showSidebar ? { display: 'none' } : undefined}>
        {/* Search bar */}
        <View className="p-2 border-b border-border">
          <View className="flex-row items-center bg-background border border-border rounded-md px-2">
            <Search size={12} className="text-muted-foreground" />
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              onSubmitEditing={handleSearch}
              placeholder="Search files..."
              placeholderTextColor="#666"
              className="flex-1 text-xs py-1.5 px-1.5 text-foreground"
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
                    'px-2 py-1 rounded-md',
                    isWorkspaceFile && selectedPath === file.id ? 'bg-primary/10' : 'active:bg-muted',
                  )}
                  style={{ paddingLeft: 24 }}
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
                  <Text className="text-[10px] text-muted-foreground" style={{ marginLeft: 18 }} numberOfLines={1}>
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
              onPress={() => { setShowNewDialog('file'); setNewName('') }}
              className="flex-1 flex-row items-center justify-center gap-1 px-2 py-1.5 rounded-md active:bg-muted border border-border"
            >
              <FilePlus size={12} className="text-muted-foreground" />
              <Text className="text-[10px] text-muted-foreground">New File</Text>
            </Pressable>
            <Pressable
              onPress={() => { setShowNewDialog('folder'); setNewName('') }}
              className="flex-1 flex-row items-center justify-center gap-1 px-2 py-1.5 rounded-md active:bg-muted border border-border"
            >
              <FolderPlus size={12} className="text-muted-foreground" />
              <Text className="text-[10px] text-muted-foreground">New Folder</Text>
            </Pressable>
          </View>
          <Pressable
            onPress={handleUpload}
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
          <View className="absolute bottom-16 left-2 right-2 bg-background border border-border rounded-lg p-3 shadow-lg z-10">
            <Text className="text-xs font-medium text-foreground mb-2">
              New {showNewDialog === 'file' ? 'File' : 'Folder'}
            </Text>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              placeholder={showNewDialog === 'file' ? 'filename.txt' : 'folder-name'}
              placeholderTextColor="#666"
              className="text-xs border border-border rounded-md px-2 py-1.5 mb-2 text-foreground bg-muted/30"
              autoCapitalize="none"
              autoFocus
              onSubmitEditing={handleCreateNew}
            />
            <View className="flex-row gap-2">
              <Pressable
                onPress={() => setShowNewDialog(null)}
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
      <View className="flex-1 flex-col" style={!showEditor ? { display: 'none' } : undefined}>
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
                  className="flex-row items-center gap-1 px-2 py-1 rounded-md bg-primary active:bg-primary/80"
                  style={!hasChanges || isSaving ? { opacity: 0.5 } : undefined}
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
                className="flex-1 p-4 font-mono text-sm bg-background text-foreground"
                placeholder="Edit file..."
                placeholderTextColor="#666"
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
