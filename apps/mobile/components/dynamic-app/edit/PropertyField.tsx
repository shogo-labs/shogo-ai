import { useState, useCallback } from 'react'
import { View, TextInput, Pressable, Switch } from 'react-native'
import { Text } from '@/components/ui/text'
import { ChevronDown } from 'lucide-react-native'
import type { PropDef } from '@shogo/shared-app/dynamic-app'

interface PropertyFieldProps {
  name: string
  propDef: PropDef
  value: unknown
  onChange: (value: unknown) => void
}

export function PropertyField({ name, propDef, value, onChange }: PropertyFieldProps) {
  return (
    <View className="gap-1">
      <View className="flex-row items-center justify-between">
        <Text className="text-xs font-medium text-muted-foreground">{name}</Text>
        {propDef.required && <Text className="text-xs text-destructive">*</Text>}
      </View>
      <FieldInput propDef={propDef} value={value} onChange={onChange} />
    </View>
  )
}

function FieldInput({ propDef, value, onChange }: { propDef: PropDef; value: unknown; onChange: (v: unknown) => void }) {
  if (propDef.type === 'boolean') {
    return <BooleanField value={value} onChange={onChange} />
  }
  if (propDef.enum && propDef.enum.length > 0) {
    return <EnumField options={propDef.enum} value={value} onChange={onChange} />
  }
  if (propDef.type === 'number') {
    return <NumberField value={value} onChange={onChange} />
  }
  if (propDef.type === 'object' || propDef.type === 'array') {
    return <JsonField value={value} onChange={onChange} />
  }
  return <StringField value={value} onChange={onChange} />
}

function StringField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const [localValue, setLocalValue] = useState(value != null ? String(value) : '')

  const handleBlur = useCallback(() => {
    onChange(localValue || undefined)
  }, [localValue, onChange])

  return (
    <TextInput
      value={localValue}
      onChangeText={setLocalValue}
      onBlur={handleBlur}
      className="border border-border rounded-md px-2.5 py-1.5 text-xs text-foreground bg-background"
      placeholderTextColor="#9ca3af"
    />
  )
}

function NumberField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const [localValue, setLocalValue] = useState(value != null ? String(value) : '')

  const handleBlur = useCallback(() => {
    const num = Number(localValue)
    onChange(isNaN(num) ? undefined : num)
  }, [localValue, onChange])

  return (
    <TextInput
      value={localValue}
      onChangeText={setLocalValue}
      onBlur={handleBlur}
      keyboardType="numeric"
      className="border border-border rounded-md px-2.5 py-1.5 text-xs text-foreground bg-background"
      placeholderTextColor="#9ca3af"
    />
  )
}

function BooleanField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  return (
    <View className="flex-row items-center">
      <Switch
        value={!!value}
        onValueChange={(v) => onChange(v)}
        style={{ transform: [{ scale: 0.8 }] }}
      />
    </View>
  )
}

function EnumField({ options, value, onChange }: { options: string[]; value: unknown; onChange: (v: unknown) => void }) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <View>
      <Pressable
        onPress={() => setIsOpen(!isOpen)}
        className="flex-row items-center justify-between border border-border rounded-md px-2.5 py-1.5 bg-background"
      >
        <Text className="text-xs text-foreground">{value != null ? String(value) : '(none)'}</Text>
        <ChevronDown size={12} className="text-muted-foreground" />
      </Pressable>

      {isOpen && (
        <View className="border border-border rounded-md mt-1 bg-background max-h-40 overflow-hidden">
          <Pressable
            onPress={() => { onChange(undefined); setIsOpen(false) }}
            className="px-2.5 py-1.5 border-b border-border"
          >
            <Text className="text-xs text-muted-foreground italic">(none)</Text>
          </Pressable>
          {options.map((opt) => (
            <Pressable
              key={opt}
              onPress={() => { onChange(opt); setIsOpen(false) }}
              className={`px-2.5 py-1.5 ${opt === String(value) ? 'bg-primary/10' : ''}`}
            >
              <Text className={`text-xs ${opt === String(value) ? 'text-primary font-medium' : 'text-foreground'}`}>
                {opt}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  )
}

function JsonField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const [localValue, setLocalValue] = useState(
    value != null ? JSON.stringify(value, null, 2) : ''
  )
  const [error, setError] = useState<string | null>(null)

  const handleBlur = useCallback(() => {
    if (!localValue.trim()) {
      onChange(undefined)
      setError(null)
      return
    }
    try {
      const parsed = JSON.parse(localValue)
      onChange(parsed)
      setError(null)
    } catch {
      setError('Invalid JSON')
    }
  }, [localValue, onChange])

  return (
    <View className="gap-1">
      <TextInput
        value={localValue}
        onChangeText={setLocalValue}
        onBlur={handleBlur}
        multiline
        numberOfLines={4}
        className="border border-border rounded-md px-2.5 py-1.5 text-xs text-foreground bg-background font-mono"
        style={{ minHeight: 60, textAlignVertical: 'top' }}
        placeholderTextColor="#9ca3af"
      />
      {error && <Text className="text-xs text-destructive">{error}</Text>}
    </View>
  )
}
