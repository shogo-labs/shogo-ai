/**
 * Interactive Components for Dynamic App (React Native)
 *
 * Components that handle user input and dispatch actions back to the agent.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { View, Pressable, Linking } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Button, ButtonText } from '@/components/ui/button'

import {
  Checkbox,
  CheckboxIndicator,
  CheckboxIcon,
  CheckboxLabel,
} from '@/components/ui/checkbox'
import { Input, InputField } from '@/components/ui/input'
import { Text } from '@/components/ui/text'
import {
  Select,
  SelectTrigger,
  SelectInput,
  SelectIcon,
  SelectPortal,
  SelectBackdrop,
  SelectContent,
  SelectDragIndicator,
  SelectDragIndicatorWrapper,
  SelectItem,
} from '@/components/ui/select'
import { ChevronDown, Check as CheckIcon } from 'lucide-react-native'

interface ActionDef {
  name: string
  context?: Record<string, unknown>
}

const BUTTON_ACTION_MAP: Record<string, 'primary' | 'secondary' | 'positive' | 'negative' | 'default'> = {
  default: 'primary',
  secondary: 'secondary',
  destructive: 'negative',
  outline: 'primary',
  ghost: 'default',
  link: 'primary',
}

const BUTTON_VARIANT_MAP: Record<string, 'solid' | 'outline' | 'link'> = {
  default: 'solid',
  secondary: 'solid',
  destructive: 'solid',
  outline: 'outline',
  ghost: 'outline',
  link: 'link',
}

const BUTTON_SIZE_MAP: Record<string, 'xs' | 'sm' | 'md' | 'lg' | 'xl'> = {
  default: 'md',
  sm: 'sm',
  lg: 'lg',
  icon: 'sm',
}

const BUTTON_CLASS_OVERRIDES: Record<string, string> = {
  default: 'bg-primary rounded-md',
  secondary: 'bg-secondary rounded-md',
  destructive: 'bg-destructive rounded-md',
  outline: 'border-border rounded-md',
  ghost: 'rounded-md',
  link: '',
}

const BUTTON_TEXT_OVERRIDES: Record<string, string> = {
  default: 'text-primary-foreground',
  secondary: 'text-secondary-foreground',
  destructive: 'text-destructive-foreground',
  outline: 'text-foreground',
  ghost: 'text-foreground',
  link: 'text-primary',
}

interface DynButtonProps {
  label?: string
  text?: string
  variant?: 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost' | 'link'
  size?: 'default' | 'sm' | 'lg' | 'icon'
  disabled?: boolean
  href?: string
  action?: ActionDef
  onAction?: (name: string, context?: Record<string, unknown>) => void
  className?: string
}

export function DynButton({ label, text, variant = 'default', size = 'default', disabled, href, action, onAction, className }: DynButtonProps) {
  const isMisconfigured = !href && !action

  const handlePress = useCallback(() => {
    if (href) {
      Linking.openURL(href)
      return
    }
    const mutation = action?.context?._mutation as { endpoint?: string; method?: string } | undefined
    if (mutation?.method?.toUpperCase() === 'OPEN' && mutation.endpoint) {
      Linking.openURL(mutation.endpoint)
      return
    }
    if (action && onAction) {
      if (!mutation) {
        console.warn(`[DynamicApp] Button "${label || text || 'unnamed'}" clicked with action "${action.name}" but no _mutation in context. This button may not do anything. Ensure the button definition includes action.mutation.`)
      }
      onAction(action.name, action.context)
      return
    }
    console.warn(`[DynamicApp] Button "${label || text || 'unnamed'}" pressed but has no action or href configured. It will do nothing.`)
  }, [href, action, onAction, label, text])

  if (isMisconfigured) {
    return (
      <View className={cn('flex-row items-center gap-1.5', className)}>
        <Button
          action="negative"
          variant="outline"
          size={BUTTON_SIZE_MAP[size] || 'md'}
          isDisabled
          className="border-destructive/50 opacity-70"
        >
          <ButtonText className="text-destructive">
            {label || text || 'Button'} (no action)
          </ButtonText>
        </Button>
      </View>
    )
  }

  return (
    <Button
      action={BUTTON_ACTION_MAP[variant] || 'primary'}
      variant={BUTTON_VARIANT_MAP[variant] || 'solid'}
      size={BUTTON_SIZE_MAP[size] || 'md'}
      isDisabled={disabled}
      onPress={handlePress}
      className={cn(BUTTON_CLASS_OVERRIDES[variant] || BUTTON_CLASS_OVERRIDES.default, className)}
    >
      <ButtonText className={BUTTON_TEXT_OVERRIDES[variant] || BUTTON_TEXT_OVERRIDES.default}>
        {label || text || 'Button'}
      </ButtonText>
    </Button>
  )
}

interface DynTextFieldProps {
  label?: string
  placeholder?: string
  value?: string
  type?: string
  disabled?: boolean
  action?: ActionDef
  onAction?: (name: string, context?: Record<string, unknown>) => void
  onDataChange?: (path: string, value: unknown) => void
  dataPath?: string
  debounceMs?: number
  className?: string
}

export function DynTextField({ label, placeholder, value = '', type = 'text', disabled, action, onAction, onDataChange, dataPath, debounceMs = 0, className }: DynTextFieldProps) {
  const [localValue, setLocalValue] = useState(value)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setLocalValue(value)
  }, [value])

  const emitDataChange = useCallback((newVal: string) => {
    if (dataPath && onDataChange) {
      onDataChange(dataPath, newVal)
    }
  }, [dataPath, onDataChange])

  const handleChangeText = useCallback((newVal: string) => {
    setLocalValue(newVal)
    if (debounceMs > 0) {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => emitDataChange(newVal), debounceMs)
    } else {
      emitDataChange(newVal)
    }
  }, [debounceMs, emitDataChange])

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const handleSubmitEditing = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    emitDataChange(localValue)
    if (action && onAction) {
      onAction(action.name, { ...action.context, value: localValue })
    }
  }, [action, onAction, localValue, emitDataChange])

  return (
    <View className={cn('flex flex-col gap-1.5', className)}>
      {label && <Text className="text-sm font-medium">{label}</Text>}
      <Input isDisabled={disabled}>
        <InputField
          placeholder={placeholder}
          value={localValue}
          onChangeText={handleChangeText}
          onSubmitEditing={handleSubmitEditing}
          secureTextEntry={type === 'password'}
          keyboardType={type === 'number' ? 'numeric' : type === 'email' ? 'email-address' : 'default'}
        />
      </Input>
    </View>
  )
}

interface SelectOption {
  label: string
  value: string
}

interface DynSelectProps {
  label?: string
  options?: SelectOption[]
  value?: string
  placeholder?: string
  disabled?: boolean
  action?: ActionDef
  onAction?: (name: string, context?: Record<string, unknown>) => void
  onDataChange?: (path: string, value: unknown) => void
  dataPath?: string
  className?: string
}

export function DynSelect({ label, options = [], value = '', placeholder, disabled, action, onAction, onDataChange, dataPath, className }: DynSelectProps) {
  const handleValueChange = useCallback((newVal: string) => {
    if (dataPath && onDataChange) {
      onDataChange(dataPath, newVal)
    }
    if (action && onAction) {
      onAction(action.name, { ...action.context, value: newVal })
    }
  }, [action, onAction, dataPath, onDataChange])

  return (
    <View className={cn('flex flex-col gap-1.5', className)}>
      {label && <Text className="text-sm font-medium">{label}</Text>}
      <Select
        selectedValue={value}
        onValueChange={handleValueChange}
        isDisabled={disabled}
      >
        <SelectTrigger>
          <SelectInput placeholder={placeholder || 'Select...'} />
          <SelectIcon className="mr-3" as={ChevronDown} />
        </SelectTrigger>
        <SelectPortal>
          <SelectBackdrop />
          <SelectContent>
            <SelectDragIndicatorWrapper>
              <SelectDragIndicator />
            </SelectDragIndicatorWrapper>
            {options.map((opt) => (
              <SelectItem key={opt.value} label={opt.label} value={opt.value} />
            ))}
          </SelectContent>
        </SelectPortal>
      </Select>
    </View>
  )
}

interface DynCheckboxProps {
  label?: string
  checked?: boolean
  disabled?: boolean
  action?: ActionDef
  onAction?: (name: string, context?: Record<string, unknown>) => void
  onDataChange?: (path: string, value: unknown) => void
  dataPath?: string
  className?: string
}

export function DynCheckbox({ label, checked = false, disabled, action, onAction, onDataChange, dataPath, className }: DynCheckboxProps) {
  const [localChecked, setLocalChecked] = useState(checked)

  useEffect(() => {
    setLocalChecked(checked)
  }, [checked])

  const handleChange = useCallback((isChecked: boolean) => {
    setLocalChecked(isChecked)
    if (dataPath && onDataChange) {
      onDataChange(dataPath, isChecked)
    }
    if (action && onAction) {
      onAction(action.name, { ...action.context, checked: isChecked })
    }
  }, [action, onAction, dataPath, onDataChange])

  return (
    <Checkbox
      value="dynamic-checkbox"
      isChecked={localChecked}
      onChange={handleChange}
      isDisabled={disabled}
      className={cn(className)}
    >
      <CheckboxIndicator>
        <CheckboxIcon as={CheckIcon} />
      </CheckboxIndicator>
      {label && <CheckboxLabel>{label}</CheckboxLabel>}
    </Checkbox>
  )
}

interface ChoiceOption {
  label: string
  value: string
}

interface DynChoicePickerProps {
  label?: string
  options?: ChoiceOption[]
  value?: string | string[]
  multiple?: boolean
  variant?: 'radio' | 'chip'
  action?: ActionDef
  onAction?: (name: string, context?: Record<string, unknown>) => void
  onDataChange?: (path: string, value: unknown) => void
  dataPath?: string
  className?: string
}

export function DynChoicePicker({ label, options = [], value, multiple, action, onAction, onDataChange, dataPath, className }: DynChoicePickerProps) {
  const [selected, setSelected] = useState<string[]>(
    Array.isArray(value) ? value : value ? [value] : []
  )

  const handleSelect = useCallback((optValue: string) => {
    setSelected((prev) => {
      let next: string[]
      if (multiple) {
        next = prev.includes(optValue) ? prev.filter((v) => v !== optValue) : [...prev, optValue]
      } else {
        next = [optValue]
      }
      if (dataPath && onDataChange) {
        onDataChange(dataPath, multiple ? next : next[0])
      }
      if (action && onAction) {
        onAction(action.name, { ...action.context, value: multiple ? next : next[0] })
      }
      return next
    })
  }, [multiple, action, onAction, dataPath, onDataChange])

  return (
    <View className={cn('flex flex-col gap-2', className)}>
      {label && <Text className="text-sm font-medium">{label}</Text>}
      <View className="flex flex-row flex-wrap gap-2">
        {options.map((opt) => {
          const isSelected = selected.includes(opt.value)
          return (
            <Pressable
              key={opt.value}
              onPress={() => handleSelect(opt.value)}
              className={cn(
                'px-3 py-1.5 rounded-md border',
                isSelected
                  ? 'bg-primary border-primary'
                  : 'bg-background-0 border-outline-300'
              )}
            >
              <Text
                className={cn(
                  'text-sm',
                  isSelected ? 'text-primary-foreground' : 'text-foreground',
                )}
              >
                {opt.label}
              </Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}
