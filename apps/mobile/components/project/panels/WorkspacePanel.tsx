import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  ActivityIndicator,
} from 'react-native'
import { FileText, Save, RefreshCw, Eye, Pencil, Download, Upload } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

const WORKSPACE_FILES = [
  { id: 'AGENTS.md', label: 'Instructions', description: 'Operating rules and priorities' },
  { id: 'SOUL.md', label: 'Persona', description: 'Personality and boundaries' },
  { id: 'USER.md', label: 'User', description: 'User preferences' },
  { id: 'IDENTITY.md', label: 'Identity', description: 'Name, emoji, tagline' },
  { id: 'HEARTBEAT.md', label: 'Heartbeat', description: 'Autonomous task checklist' },
  { id: 'MEMORY.md', label: 'Memory', description: 'Long-lived facts' },
  { id: 'TOOLS.md', label: 'Tools', description: 'Tool notes and conventions' },
]

interface WorkspacePanelProps {
  projectId: string
  agentUrl: string | null
  visible: boolean
}

export function WorkspacePanel({ projectId, agentUrl, visible }: WorkspacePanelProps) {
  const [selectedFile, setSelectedFile] = useState(WORKSPACE_FILES[0].id)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPreview, setIsPreview] = useState(false)
  const [isExporting, setIsExporting] = useState(false)

  const hasChanges = content !== savedContent

  const loadFile = useCallback(
    async (filename: string) => {
      if (!agentUrl) return
      setIsLoading(true)
      setError(null)
      try {
        const res = await fetch(`${agentUrl}/agent/files/${filename}`)
        if (!res.ok) throw new Error('Failed to load file')
        const data = await res.json()
        setContent(data.content || '')
        setSavedContent(data.content || '')
      } catch (err: any) {
        setError(err.message)
      } finally {
        setIsLoading(false)
      }
    },
    [agentUrl],
  )

  useEffect(() => {
    if (visible) loadFile(selectedFile)
  }, [visible, selectedFile, loadFile])

  const handleSave = async () => {
    if (!agentUrl) return
    setIsSaving(true)
    setError(null)
    try {
      const res = await fetch(`${agentUrl}/agent/files/${selectedFile}`, {
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

  const handleExport = useCallback(async () => {
    if (!agentUrl) return
    setIsExporting(true)
    try {
      const res = await fetch(`${agentUrl}/agent/export`)
      if (!res.ok) throw new Error('Failed to export')
      const bundle = await res.json()
      // On native, we can't do Blob + download. Show the JSON as an alert or copy it.
      // For now, log it. A proper implementation would use Share API.
      console.log('[WorkspacePanel] Export bundle:', JSON.stringify(bundle, null, 2))
      setError(null)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsExporting(false)
    }
  }, [agentUrl])

  if (!visible) return null

  return (
    <View className="absolute inset-0 flex-row" style={{ display: visible ? 'flex' : 'none' }}>
      {/* File sidebar */}
      <View className="w-48 border-r border-border bg-muted/30">
        <ScrollView className="flex-1 p-2">
          <Text className="text-xs font-medium text-muted-foreground px-2 py-1">
            Workspace Files
          </Text>
          {WORKSPACE_FILES.map((file) => (
            <Pressable
              key={file.id}
              onPress={() => setSelectedFile(file.id)}
              className={cn(
                'px-2 py-1.5 rounded-md',
                selectedFile === file.id ? 'bg-primary/10' : 'active:bg-muted',
              )}
            >
              <View className="flex-row items-center gap-1.5">
                <FileText
                  size={12}
                  className={selectedFile === file.id ? 'text-primary' : 'text-foreground'}
                />
                <Text
                  className={cn(
                    'text-xs',
                    selectedFile === file.id
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
        </ScrollView>

        <View className="p-2 border-t border-border gap-1">
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
          <Pressable className="flex-row items-center gap-1.5 px-2 py-1.5 rounded-md active:bg-muted">
            <Upload size={12} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">Import Agent</Text>
          </Pressable>
        </View>
      </View>

      {/* Editor area */}
      <View className="flex-1 flex-col">
        <View className="px-3 py-2 border-b border-border flex-row items-center gap-2">
          <Text className="text-sm font-medium text-foreground">{selectedFile}</Text>
          {hasChanges && <Text className="text-xs text-amber-500">unsaved</Text>}

          <View className="ml-auto flex-row items-center gap-1">
            <Pressable
              onPress={() => setIsPreview(!isPreview)}
              className={cn(
                'flex-row items-center gap-1 px-2 py-1 rounded-md',
                isPreview ? 'bg-primary/10' : 'active:bg-muted',
              )}
            >
              {isPreview ? (
                <Pencil size={12} className="text-primary" />
              ) : (
                <Eye size={12} className="text-muted-foreground" />
              )}
              <Text
                className={cn(
                  'text-xs',
                  isPreview ? 'text-primary' : 'text-muted-foreground',
                )}
              >
                {isPreview ? 'Edit' : 'Preview'}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => loadFile(selectedFile)}
              className="p-1 rounded-md active:bg-muted"
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
              <Text className="text-xs text-primary-foreground">Save</Text>
            </Pressable>
          </View>
        </View>

        {error && (
          <View className="px-3 py-2 bg-destructive/10">
            <Text className="text-xs text-destructive">{error}</Text>
          </View>
        )}

        {isLoading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="small" />
          </View>
        ) : isPreview ? (
          <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
            {content ? (
              <Text className="text-sm text-foreground">{content}</Text>
            ) : (
              <Text className="text-sm text-muted-foreground italic">Nothing to preview</Text>
            )}
          </ScrollView>
        ) : (
          <TextInput
            value={content}
            onChangeText={setContent}
            className="flex-1 p-4 font-mono text-sm bg-background text-foreground"
            placeholder={`Edit ${selectedFile}...`}
            placeholderTextColor="#666"
            multiline
            textAlignVertical="top"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
          />
        )}
      </View>
    </View>
  )
}
