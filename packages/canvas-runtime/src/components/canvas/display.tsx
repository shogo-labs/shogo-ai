import { cn } from '@/lib/cn'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/

function isIsoDate(val: unknown): val is string {
  return typeof val === 'string' && val.length >= 10 && ISO_DATE_RE.test(val)
}

function formatDate(val: string): string {
  try {
    const d = new Date(val)
    if (isNaN(d.getTime())) return val
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return val }
}

function formatDisplayText(val: unknown): string {
  if (val == null) return ''
  const str = String(val)
  return isIsoDate(str) ? formatDate(str) : str
}

const VARIANT_CLASSES: Record<string, string> = {
  h1: 'text-3xl font-bold tracking-tight',
  h2: 'text-2xl font-semibold tracking-tight',
  h3: 'text-xl font-semibold',
  h4: 'text-lg font-semibold',
  h5: 'text-base font-semibold',
  h6: 'text-sm font-semibold',
  body: 'text-sm',
  caption: 'text-xs text-muted-foreground',
  code: 'font-mono text-sm bg-muted px-1.5 py-0.5 rounded',
  muted: 'text-sm text-muted-foreground',
  large: 'text-lg font-semibold',
  small: 'text-xs',
  lead: 'text-xl text-muted-foreground',
}

interface DynTextProps {
  text?: string
  variant?: string
  align?: string
  color?: string
  weight?: string
  className?: string
}

const TEXT_COLOR_MAP: Record<string, string> = {
  muted: 'text-muted-foreground',
  accent: 'text-accent-foreground',
  secondary: 'text-secondary-foreground',
}

export function DynText({ text = '', variant = 'body', align, color, weight, className }: DynTextProps) {
  const alignClass = align ? `text-${align}` : ''
  const colorClass = color ? (TEXT_COLOR_MAP[color] || `text-${color}`) : ''
  const weightClass = weight ? `font-${weight}` : ''

  return (
    <span className={cn(VARIANT_CLASSES[variant] || VARIANT_CLASSES.body, alignClass, colorClass, weightClass, className)}>
      {formatDisplayText(text)}
    </span>
  )
}

const BADGE_BG_MAP: Record<string, string> = {
  default: 'bg-primary/15',
  secondary: 'bg-secondary',
  destructive: 'bg-destructive/15',
  outline: 'bg-secondary',
}
const BADGE_TEXT_MAP: Record<string, string> = {
  default: 'text-primary',
  secondary: 'text-secondary-foreground',
  destructive: 'text-destructive',
  outline: 'text-foreground',
}

interface DynBadgeProps {
  text?: string
  variant?: string
  className?: string
}

export function DynBadge({ text = '', variant = 'default', className }: DynBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-transparent px-2.5 py-0.5 text-xs font-semibold',
        BADGE_BG_MAP[variant] || BADGE_BG_MAP.default,
        BADGE_TEXT_MAP[variant] || BADGE_TEXT_MAP.default,
        variant === 'outline' && 'border-border',
        className,
      )}
    >
      {formatDisplayText(text)}
    </span>
  )
}

interface DynImageProps {
  src?: string
  alt?: string
  width?: number | string
  height?: number | string
  fit?: string
  className?: string
}

export function DynImage({ src, alt = '', width, height, fit = 'cover', className }: DynImageProps) {
  if (!src) return <div className={cn('bg-muted rounded flex items-center justify-center text-xs text-muted-foreground', className)} style={{ width, height }}>No image</div>
  return <img src={src} alt={alt} className={cn('rounded', className)} style={{ width, height, objectFit: fit as any }} />
}

interface DynIconProps {
  name?: string
  size?: number
  color?: string
  className?: string
}

export function DynIcon({ name = 'circle', size = 20, color, className }: DynIconProps) {
  return (
    <span className={cn('inline-flex items-center justify-center', className)} style={{ width: size, height: size, color }}>
      {name}
    </span>
  )
}

export function DynSeparator({ className }: { className?: string }) {
  return <hr className={cn('border-t border-border my-2', className)} />
}

interface DynProgressProps {
  value?: number
  max?: number
  className?: string
}

export function DynProgress({ value = 0, max = 100, className }: DynProgressProps) {
  const pct = Math.min(Math.max((value / max) * 100, 0), 100)
  return (
    <div className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', className)}>
      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
    </div>
  )
}

export function DynSkeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted h-4 w-full', className)} />
}

interface DynAlertProps {
  variant?: string
  title?: string
  description?: string
  className?: string
}

const ALERT_VARIANT_MAP: Record<string, string> = {
  default: 'border-border',
  destructive: 'border-destructive/50 text-destructive',
  success: 'border-emerald-500/50 text-emerald-700',
  warning: 'border-amber-500/50 text-amber-700',
  info: 'border-blue-500/50 text-blue-700',
}

export function DynAlert({ variant = 'default', title, description, className }: DynAlertProps) {
  return (
    <div className={cn('rounded-lg border p-4', ALERT_VARIANT_MAP[variant] || ALERT_VARIANT_MAP.default, className)}>
      {title && <p className="font-medium text-sm mb-1">{title}</p>}
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
  )
}
