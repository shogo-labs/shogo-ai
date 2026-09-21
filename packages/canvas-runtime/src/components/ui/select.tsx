import { useState, createContext, useContext, useRef, useEffect, type HTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { ChevronDown } from 'lucide-react'

interface SelectContextValue {
  value: string
  onValueChange: (v: string) => void
  open: boolean
  setOpen: (v: boolean) => void
  // Maps a SelectItem's `value` to the label it rendered as children, so
  // SelectValue can show a human-readable label instead of the raw value
  // (typically a database id) once it has been seen. Registered by
  // SelectItem on mount (see `registerLabel`); intentionally NOT
  // unregistered on unmount, because SelectContent unmounts every item the
  // moment the dropdown closes (including immediately after a selection —
  // see `Select`'s handleChange below), and SelectValue must keep showing
  // the just-selected item's label after that unmount.
  labels: Map<string, ReactNode>
  registerLabel: (value: string, label: ReactNode) => void
}

const noopLabels = new Map<string, ReactNode>()
const SelectContext = createContext<SelectContextValue>({
  value: '',
  onValueChange: () => {},
  open: false,
  setOpen: () => {},
  labels: noopLabels,
  registerLabel: () => {},
})

interface SelectProps {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  children?: ReactNode
}

export function Select({ value: controlledValue, defaultValue = '', onValueChange, children }: SelectProps) {
  const [internalValue, setInternalValue] = useState(defaultValue)
  const [open, setOpen] = useState(false)
  const value = controlledValue ?? internalValue

  // Label map lives in a ref (not state) so registering a label doesn't
  // itself force a render; `labelVersion` is bumped only when a label
  // actually changes, which re-renders this Provider (and therefore every
  // context consumer, since the Provider's `value` object is recreated
  // below) without looping — a SelectItem that re-registers the same
  // value/label pair is a no-op.
  const labelsRef = useRef<Map<string, ReactNode>>(new Map())
  const [, setLabelVersion] = useState(0)

  const registerLabel = (itemValue: string, label: ReactNode) => {
    if (Object.is(labelsRef.current.get(itemValue), label)) return
    labelsRef.current.set(itemValue, label)
    setLabelVersion((v) => v + 1)
  }

  const handleChange = (v: string) => {
    setInternalValue(v)
    onValueChange?.(v)
    setOpen(false)
  }

  return (
    <SelectContext.Provider
      value={{ value, onValueChange: handleChange, open, setOpen, labels: labelsRef.current, registerLabel }}
    >
      <div className="relative">{children}</div>
    </SelectContext.Provider>
  )
}

export function SelectTrigger({ className, children, ...props }: HTMLAttributes<HTMLButtonElement>) {
  const { open, setOpen } = useContext(SelectContext)
  return (
    <button
      className={cn(
        'flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring',
        className,
      )}
      onClick={() => setOpen(!open)}
      {...props}
    >
      {children}
      <ChevronDown size={16} className="opacity-50" />
    </button>
  )
}

export function SelectValue({ placeholder }: { placeholder?: string }) {
  const { value, labels } = useContext(SelectContext)
  const label = value ? labels.get(value) ?? value : undefined
  return <span className={cn(!value && 'text-muted-foreground')}>{label ?? placeholder}</span>
}

export function SelectContent({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const { open, setOpen } = useContext(SelectContext)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, setOpen])

  if (!open) return null

  return (
    <div
      ref={ref}
      className={cn(
        'absolute z-50 mt-1 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

interface SelectItemProps extends HTMLAttributes<HTMLDivElement> {
  value: string
}

export function SelectItem({ value, className, children, ...props }: SelectItemProps) {
  const ctx = useContext(SelectContext)

  // Register this item's label whenever it is mounted (i.e. whenever the
  // dropdown is open) so SelectValue can resolve `value` -> the label the
  // user actually sees, instead of falling back to the raw id. See
  // `SelectContext.labels` for why registration outlives this component's
  // unmount.
  useEffect(() => {
    ctx.registerLabel(value, children)
  }, [value, children])

  return (
    <div
      className={cn(
        'relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent',
        ctx.value === value && 'bg-accent',
        className,
      )}
      onClick={() => ctx.onValueChange(value)}
      {...props}
    >
      {children}
    </div>
  )
}
