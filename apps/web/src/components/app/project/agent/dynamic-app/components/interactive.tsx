/**
 * Interactive Components for Dynamic App
 *
 * Components that handle user input and dispatch actions back to the agent.
 */

import { useState, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface ActionDef {
  name: string
  context?: Record<string, unknown>
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
  const handleClick = useCallback(() => {
    if (href) {
      window.open(href, '_blank', 'noopener,noreferrer')
      return
    }
    // mutation method "OPEN" opens an external URL in a new tab
    const mutation = action?.context?._mutation as { endpoint?: string; method?: string } | undefined
    if (mutation?.method?.toUpperCase() === 'OPEN' && mutation.endpoint) {
      window.open(mutation.endpoint, '_blank', 'noopener,noreferrer')
      return
    }
    if (action && onAction) {
      onAction(action.name, action.context)
    }
  }, [href, action, onAction])

  return (
    <Button variant={variant} size={size} disabled={disabled} onClick={handleClick} className={className}>
      {label || text || 'Button'}
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
  className?: string
}

export function DynTextField({ label, placeholder, value = '', type = 'text', disabled, action, onAction, onDataChange, dataPath, className }: DynTextFieldProps) {
  const [localValue, setLocalValue] = useState(value)

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value
    setLocalValue(newVal)
    if (dataPath && onDataChange) {
      onDataChange(dataPath, newVal)
    }
  }, [dataPath, onDataChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && action && onAction) {
      onAction(action.name, { ...action.context, value: localValue })
    }
  }, [action, onAction, localValue])

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && <Label>{label}</Label>}
      <Input
        type={type}
        placeholder={placeholder}
        value={localValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={disabled}
      />
    </div>
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
  const [localValue, setLocalValue] = useState(value)

  const handleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const newVal = e.target.value
    setLocalValue(newVal)
    if (dataPath && onDataChange) {
      onDataChange(dataPath, newVal)
    }
    if (action && onAction) {
      onAction(action.name, { ...action.context, value: newVal })
    }
  }, [action, onAction, dataPath, onDataChange])

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && <Label>{label}</Label>}
      <select
        value={localValue}
        onChange={handleChange}
        disabled={disabled}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
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

  const handleChange = useCallback((val: boolean | 'indeterminate') => {
    const newVal = val === true
    setLocalChecked(newVal)
    if (dataPath && onDataChange) {
      onDataChange(dataPath, newVal)
    }
    if (action && onAction) {
      onAction(action.name, { ...action.context, checked: newVal })
    }
  }, [action, onAction, dataPath, onDataChange])

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Checkbox checked={localChecked} onCheckedChange={handleChange} disabled={disabled} />
      {label && <Label className="cursor-pointer">{label}</Label>}
    </div>
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

export function DynChoicePicker({ label, options = [], value, multiple, variant = 'chip', action, onAction, onDataChange, dataPath, className }: DynChoicePickerProps) {
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
    <div className={cn('flex flex-col gap-2', className)}>
      {label && <Label>{label}</Label>}
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const isSelected = selected.includes(opt.value)
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => handleSelect(opt.value)}
              className={cn(
                'px-3 py-1.5 text-sm rounded-md border transition-colors',
                isSelected
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background text-foreground border-border hover:bg-muted'
              )}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
