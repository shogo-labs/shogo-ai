import { useState, useEffect, useCallback } from 'react'
import { View, Text, Pressable, TextInput, ActivityIndicator } from 'react-native'
import { Shield, Plus, X, RotateCcw } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../contexts/domain'
import { SecurityPreferenceSelector } from './SecurityPreferenceSelector'
import { api, type SecurityPrefs } from '../../lib/api'

type SecurityMode = 'strict' | 'balanced' | 'full_autonomy'

export function SecuritySettingsPanel() {
  const http = useDomainHttp()
  const [prefs, setPrefs] = useState<SecurityPrefs | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [newAllowCmd, setNewAllowCmd] = useState('')
  const [newDenyCmd, setNewDenyCmd] = useState('')
  const [newProtectedPath, setNewProtectedPath] = useState('')

  useEffect(() => {
    if (!http) return
    setLoading(true)
    api.getSecurityPrefs(http)
      .then(setPrefs)
      .catch(() => setPrefs({ mode: 'balanced', approvalTimeoutSeconds: 60 }))
      .finally(() => setLoading(false))
  }, [http])

  const savePrefs = useCallback(async (updated: SecurityPrefs) => {
    setPrefs(updated)
    if (!http) return
    setSaving(true)
    try {
      await api.saveSecurityPrefs(http, updated)
    } catch {
      // Silent fail — local save
    } finally {
      setSaving(false)
    }
  }, [http])

  const handleModeChange = useCallback((mode: SecurityMode) => {
    if (prefs) savePrefs({ ...prefs, mode })
  }, [prefs, savePrefs])

  const addAllowCommand = useCallback(() => {
    if (!newAllowCmd.trim() || !prefs) return
    const allow = [...(prefs.overrides?.shellCommands?.allow ?? []), newAllowCmd.trim()]
    savePrefs({
      ...prefs,
      overrides: {
        ...prefs.overrides,
        shellCommands: { ...prefs.overrides?.shellCommands, allow },
      },
    })
    setNewAllowCmd('')
  }, [newAllowCmd, prefs, savePrefs])

  const removeAllowCommand = useCallback((idx: number) => {
    if (!prefs) return
    const allow = [...(prefs.overrides?.shellCommands?.allow ?? [])]
    allow.splice(idx, 1)
    savePrefs({
      ...prefs,
      overrides: {
        ...prefs.overrides,
        shellCommands: { ...prefs.overrides?.shellCommands, allow },
      },
    })
  }, [prefs, savePrefs])

  const addDenyCommand = useCallback(() => {
    if (!newDenyCmd.trim() || !prefs) return
    const deny = [...(prefs.overrides?.shellCommands?.deny ?? []), newDenyCmd.trim()]
    savePrefs({
      ...prefs,
      overrides: {
        ...prefs.overrides,
        shellCommands: { ...prefs.overrides?.shellCommands, deny },
      },
    })
    setNewDenyCmd('')
  }, [newDenyCmd, prefs, savePrefs])

  const removeDenyCommand = useCallback((idx: number) => {
    if (!prefs) return
    const deny = [...(prefs.overrides?.shellCommands?.deny ?? [])]
    deny.splice(idx, 1)
    savePrefs({
      ...prefs,
      overrides: {
        ...prefs.overrides,
        shellCommands: { ...prefs.overrides?.shellCommands, deny },
      },
    })
  }, [prefs, savePrefs])

  const addProtectedPath = useCallback(() => {
    if (!newProtectedPath.trim() || !prefs) return
    const deny = [...(prefs.overrides?.fileAccess?.deny ?? []), newProtectedPath.trim()]
    savePrefs({
      ...prefs,
      overrides: {
        ...prefs.overrides,
        fileAccess: { ...prefs.overrides?.fileAccess, deny },
      },
    })
    setNewProtectedPath('')
  }, [newProtectedPath, prefs, savePrefs])

  const removeProtectedPath = useCallback((idx: number) => {
    if (!prefs) return
    const deny = [...(prefs.overrides?.fileAccess?.deny ?? [])]
    deny.splice(idx, 1)
    savePrefs({
      ...prefs,
      overrides: {
        ...prefs.overrides,
        fileAccess: { ...prefs.overrides?.fileAccess, deny },
      },
    })
  }, [prefs, savePrefs])

  const resetToDefaults = useCallback(() => {
    savePrefs({
      mode: 'balanced',
      overrides: {},
      approvalTimeoutSeconds: 60,
    })
  }, [savePrefs])

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center py-12">
        <ActivityIndicator />
      </View>
    )
  }

  if (!prefs) return null

  const allowList = prefs.overrides?.shellCommands?.allow ?? []
  const denyList = prefs.overrides?.shellCommands?.deny ?? []
  const protectedPaths = prefs.overrides?.fileAccess?.deny ?? []

  return (
    <View className="gap-8">
      {/* Mode selector */}
      <View className="gap-3">
        <View className="flex-row items-center justify-between">
          <Text className="text-base font-semibold text-foreground">Default Security Mode</Text>
          {saving && <ActivityIndicator size="small" />}
        </View>
        <SecurityPreferenceSelector value={prefs.mode} onChange={handleModeChange} compact />
      </View>

      {/* Shell command rules */}
      <View className="gap-3">
        <Text className="text-base font-semibold text-foreground">Shell Command Rules</Text>

        <View className="gap-2">
          <Text className="text-sm text-muted-foreground">Always Allow</Text>
          <View className="flex-row flex-wrap gap-2">
            {allowList.map((cmd, i) => (
              <ChipTag key={`allow-${i}`} label={cmd} onRemove={() => removeAllowCommand(i)} />
            ))}
            <View className="flex-row items-center gap-1">
              <TextInput
                value={newAllowCmd}
                onChangeText={setNewAllowCmd}
                placeholder="e.g. npm *"
                className="bg-background border border-border rounded-lg px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground w-28"
                onSubmitEditing={addAllowCommand}
              />
              <Pressable onPress={addAllowCommand} className="p-1.5 rounded-md bg-muted">
                <Plus size={12} className="text-muted-foreground" />
              </Pressable>
            </View>
          </View>
        </View>

        <View className="gap-2">
          <Text className="text-sm text-muted-foreground">Always Deny</Text>
          <View className="flex-row flex-wrap gap-2">
            {denyList.map((cmd, i) => (
              <ChipTag key={`deny-${i}`} label={cmd} variant="destructive" onRemove={() => removeDenyCommand(i)} />
            ))}
            <View className="flex-row items-center gap-1">
              <TextInput
                value={newDenyCmd}
                onChangeText={setNewDenyCmd}
                placeholder="e.g. rm -rf *"
                className="bg-background border border-border rounded-lg px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground w-28"
                onSubmitEditing={addDenyCommand}
              />
              <Pressable onPress={addDenyCommand} className="p-1.5 rounded-md bg-muted">
                <Plus size={12} className="text-muted-foreground" />
              </Pressable>
            </View>
          </View>
        </View>
      </View>

      {/* Protected paths */}
      <View className="gap-3">
        <Text className="text-base font-semibold text-foreground">Protected Paths</Text>
        <View className="flex-row flex-wrap gap-2">
          {protectedPaths.map((p, i) => (
            <ChipTag key={`path-${i}`} label={p} onRemove={() => removeProtectedPath(i)} />
          ))}
          <View className="flex-row items-center gap-1">
            <TextInput
              value={newProtectedPath}
              onChangeText={setNewProtectedPath}
              placeholder="e.g. ~/.ssh"
              className="bg-background border border-border rounded-lg px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground w-28"
              onSubmitEditing={addProtectedPath}
            />
            <Pressable onPress={addProtectedPath} className="p-1.5 rounded-md bg-muted">
              <Plus size={12} className="text-muted-foreground" />
            </Pressable>
          </View>
        </View>
      </View>

      {/* Reset */}
      <Pressable
        onPress={resetToDefaults}
        className="flex-row items-center justify-center gap-2 py-3 rounded-xl border border-border"
      >
        <RotateCcw size={14} className="text-muted-foreground" />
        <Text className="text-sm text-muted-foreground">Reset to Defaults</Text>
      </Pressable>
    </View>
  )
}

function ChipTag({
  label,
  variant = 'default',
  onRemove,
}: {
  label: string
  variant?: 'default' | 'destructive'
  onRemove: () => void
}) {
  return (
    <View
      className={cn(
        'flex-row items-center gap-1 px-2 py-1 rounded-md',
        variant === 'destructive' ? 'bg-destructive/10' : 'bg-muted',
      )}
    >
      <Text
        className={cn(
          'text-xs font-mono',
          variant === 'destructive' ? 'text-destructive' : 'text-foreground',
        )}
      >
        {label}
      </Text>
      <Pressable onPress={onRemove} className="p-0.5">
        <X
          size={10}
          className={variant === 'destructive' ? 'text-destructive' : 'text-muted-foreground'}
        />
      </Pressable>
    </View>
  )
}

export default SecuritySettingsPanel
