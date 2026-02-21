/**
 * Display Components for Dynamic App
 *
 * Read-only visual components that render text, badges, icons, etc.
 */

import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import {
  AlertCircle, AlertTriangle, CheckCircle, Info, Mail, Search, Star,
  Clock, Calendar, MapPin, Phone, Globe, User, Heart, Bookmark,
  Download, Upload, Settings, ArrowRight, ArrowLeft, ArrowUp, ArrowDown,
  ChevronRight, ChevronLeft, ChevronUp, ChevronDown,
  Plus, Minus, X, Check, Loader2, ExternalLink, Copy, Trash2, Edit,
  Eye, EyeOff, Lock, Unlock, Bell, BellOff, Zap, Shield, TrendingUp,
  TrendingDown, DollarSign, Plane, Car, Home, Building, Package,
  type LucideIcon,
} from 'lucide-react'

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

interface TextProps {
  text?: string
  variant?: string
  align?: string
  color?: string
  weight?: string
  className?: string
}

export function DynText({ text = '', variant = 'body', align, color, weight, className }: TextProps) {
  const alignClass = align ? `text-${align}` : ''
  const colorClass = color ? `text-${color}` : ''
  const weightClass = weight ? `font-${weight}` : ''

  if (variant === 'h1') return <h1 className={cn(VARIANT_CLASSES.h1, alignClass, colorClass, weightClass, className)}>{text}</h1>
  if (variant === 'h2') return <h2 className={cn(VARIANT_CLASSES.h2, alignClass, colorClass, weightClass, className)}>{text}</h2>
  if (variant === 'h3') return <h3 className={cn(VARIANT_CLASSES.h3, alignClass, colorClass, weightClass, className)}>{text}</h3>
  if (variant === 'code') return <code className={cn(VARIANT_CLASSES.code, alignClass, colorClass, className)}>{text}</code>

  return <p className={cn(VARIANT_CLASSES[variant] || VARIANT_CLASSES.body, alignClass, colorClass, weightClass, className)}>{text}</p>
}

interface BadgeProps {
  text?: string
  label?: string
  variant?: 'default' | 'secondary' | 'destructive' | 'outline'
  className?: string
}

export function DynBadge({ text, label, variant = 'default', className }: BadgeProps) {
  return <Badge variant={variant} className={className}>{text || label}</Badge>
}

interface ImageProps {
  src?: string
  alt?: string
  width?: number | string
  height?: number | string
  fit?: string
  rounded?: boolean
  className?: string
}

export function DynImage({ src, alt = '', width, height, fit = 'cover', rounded, className }: ImageProps) {
  return (
    <img
      src={src}
      alt={alt}
      className={cn('max-w-full', rounded && 'rounded-lg', className)}
      style={{
        width: width ? (typeof width === 'number' ? `${width}px` : width) : undefined,
        height: height ? (typeof height === 'number' ? `${height}px` : height) : undefined,
        objectFit: fit as any,
      }}
    />
  )
}

const ICON_MAP: Record<string, LucideIcon> = {
  'alert-circle': AlertCircle, 'alert-triangle': AlertTriangle,
  'check-circle': CheckCircle, info: Info, mail: Mail, search: Search,
  star: Star, clock: Clock, calendar: Calendar, 'map-pin': MapPin,
  phone: Phone, globe: Globe, user: User, heart: Heart,
  bookmark: Bookmark, download: Download, upload: Upload, settings: Settings,
  'arrow-right': ArrowRight, 'arrow-left': ArrowLeft,
  'arrow-up': ArrowUp, 'arrow-down': ArrowDown,
  'chevron-right': ChevronRight, 'chevron-left': ChevronLeft,
  'chevron-up': ChevronUp, 'chevron-down': ChevronDown,
  plus: Plus, minus: Minus, x: X, check: Check,
  loader: Loader2, 'external-link': ExternalLink, copy: Copy,
  trash: Trash2, edit: Edit, eye: Eye, 'eye-off': EyeOff,
  lock: Lock, unlock: Unlock, bell: Bell, 'bell-off': BellOff,
  zap: Zap, shield: Shield, 'trending-up': TrendingUp,
  'trending-down': TrendingDown, 'dollar-sign': DollarSign,
  plane: Plane, car: Car, home: Home, building: Building,
  package: Package,
}

const ICON_SIZE_MAP: Record<string, string> = {
  xs: 'size-3',
  sm: 'size-4',
  md: 'size-5',
  lg: 'size-6',
  xl: 'size-8',
}

interface IconProps {
  name?: string
  size?: string
  color?: string
  className?: string
}

export function DynIcon({ name = 'info', size = 'md', color, className }: IconProps) {
  const IconComp = ICON_MAP[name.toLowerCase()]
  if (!IconComp) {
    return <span className={cn('text-muted-foreground', className)} title={`Unknown icon: ${name}`}>?</span>
  }
  return <IconComp className={cn(ICON_SIZE_MAP[size] || 'size-5', color && `text-${color}`, className)} />
}

interface SeparatorProps {
  orientation?: 'horizontal' | 'vertical'
  className?: string
}

export function DynSeparator({ orientation = 'horizontal', className }: SeparatorProps) {
  return <Separator orientation={orientation} className={className} />
}

interface ProgressProps {
  value?: number
  max?: number
  className?: string
}

export function DynProgress({ value = 0, max = 100, className }: ProgressProps) {
  return <Progress value={(value / max) * 100} className={className} />
}

interface SkeletonProps {
  width?: string | number
  height?: string | number
  rounded?: boolean
  className?: string
}

export function DynSkeleton({ width, height = '20px', rounded, className }: SkeletonProps) {
  return (
    <Skeleton
      className={cn(rounded && 'rounded-full', className)}
      style={{
        width: width ? (typeof width === 'number' ? `${width}px` : width) : '100%',
        height: typeof height === 'number' ? `${height}px` : height,
      }}
    />
  )
}

interface AlertProps {
  title?: string
  description?: string
  variant?: 'default' | 'destructive'
  icon?: string
  className?: string
}

export function DynAlert({ title, description, variant = 'default', icon, className }: AlertProps) {
  const IconComp = icon ? ICON_MAP[icon.toLowerCase()] : (variant === 'destructive' ? AlertCircle : Info)

  return (
    <Alert variant={variant} className={className}>
      {IconComp && <IconComp className="size-4" />}
      {title && <AlertTitle>{title}</AlertTitle>}
      {description && <AlertDescription>{description}</AlertDescription>}
    </Alert>
  )
}
