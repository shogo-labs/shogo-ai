import { useState, useEffect, useCallback } from 'react'
import { View, Pressable, ActivityIndicator } from 'react-native'
import {
  Shield as ShieldIcon,
  Plus as PlusIcon,
  X as XIcon,
  RotateCcw as RotateCcwIcon,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../contexts/domain'
import { SecurityPreferenceSelector } from './SecurityPreferenceSelector'
import { api, type SecurityPrefs } from '../../lib/api'
import {
  ACTION_RULES,
  RULE_LABEL,
  SUGGESTED_TOOLS,
  actionRules,
  effectiveRule,
  withActionRule,
  type ActionRule,
} from '../../lib/security-action-rules'
import {
  Text,
  TextInput,
  useAccountSheetIcons,
} from '../settings/account-sheet-chrome'

type SecurityMode = 'strict' | 'balanced' | 'full_autonomy'

export function SecuritySettingsPanel() {
  const { Shield, Plus, RotateCcw } = useAccountSheetIcons({
    Shield: ShieldIcon,
    Plus: PlusIcon,
    RotateCcw: RotateCcwIcon,
  })
  const http = useDomainHttp()
  const [prefs, setPrefs] = useState<SecurityPrefs | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [newAllowCmd, setNewAllowCmd] = useState('')
  const [newDenyCmd, setNewDenyCmd] = useState('')
  const [newProtectedPath, setNewProtectedPath] = useState('')
  const [newRuleTool, setNewRuleTool] = useState('')

  useEffect(() => {
    if (!http) return
    setLoading(true)
    api.getSecurityPrefs(http)
      .then(setPrefs)
      .catch(() => setPrefs({ mode: 'full_autonomy', approvalTimeoutSeconds: 60 }))
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

  const setToolRule = useCallback((tool: string, rule: ActionRule | null) => {
    if (prefs) savePrefs(withActionRule(prefs, tool, rule))
  }, [prefs, savePrefs])

  const addToolRule = useCallback(() => {
    if (!newRuleTool.trim() || !prefs) return
    savePrefs(withActionRule(prefs, newRuleTool, 'ask'))
    setNewRuleTool('')
  }, [newRuleTool, prefs, savePrefs])

  const resetToDefaults = useCallback(() => {
    savePrefs({
      mode: 'full_autonomy',
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
  const setRules = actionRules(prefs)
  const ruleTools = [...new Set([...SUGGESTED_TOOLS.map((t) => t.tool), ...Object.keys(setRules)])]
  const toolLabel = (tool: string) => SUGGESTED_TOOLS.find((t) => t.tool === tool)?.label ?? tool

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

      {/* Per-tool rules */}
      <View className="gap-3">
        <Text className="text-base font-semibold text-foreground">Tool Rules</Text>
        <Text className="text-xs text-muted-foreground">
          Choose what an agent may do on its own. “Ask first” waits for a person to approve, in the chat thread or here; “Block” never runs it.
        </Text>
        {ruleTools.map((tool) => {
          const current = effectiveRule(prefs, tool)
          return (
            <View key={tool} className="flex-row items-center justify-between gap-2">
              <View className="min-w-0 flex-1">
                <Text className="text-sm text-foreground">{toolLabel(tool)}</Text>
                {toolLabel(tool) !== tool ? <Text className="text-[11px] font-mono text-muted-foreground">{tool}</Text> : null}
              </View>
              <View className="flex-row overflow-hidden rounded-lg border border-border">
                {ACTION_RULES.map((rule) => (
                  <Pressable
                    key={rule}
                    onPress={() => setToolRule(tool, rule)}
                    accessibilityRole="button"
                    accessibilityLabel={`${toolLabel(tool)}: ${RULE_LABEL[rule]}`}
                    accessibilityState={{ selected: current === rule }}
                    className={cn('px-2.5 py-1.5', current === rule ? (rule === 'block' ? 'bg-destructive/15' : 'bg-primary/15') : 'bg-background')}
                  >
                    <Text className={cn('text-xs', current === rule ? 'font-medium text-foreground' : 'text-muted-foreground')}>{RULE_LABEL[rule]}</Text>
                  </Pressable>
                ))}
              </View>
              {setRules[tool] ? (
                <Pressable onPress={() => setToolRule(tool, null)} accessibilityLabel={`Reset ${toolLabel(tool)} to default`} className="p-1.5">
                  <RotateCcw size={12} className="text-muted-foreground" />
                </Pressable>
              ) : null}
            </View>
          )
        })}
        <View className="flex-row items-center gap-1">
          <TextInput
            value={newRuleTool}
            onChangeText={setNewRuleTool}
            placeholder="Add a tool, e.g. exec"
            className="bg-background border border-border rounded-lg px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground w-44"
            onSubmitEditing={addToolRule}
          />
          <Pressable onPress={addToolRule} className="p-1.5 rounded-md bg-muted">
            <Plus size={12} className="text-muted-foreground" />
          </Pressable>
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
  const { X } = useAccountSheetIcons({ X: XIcon })
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
