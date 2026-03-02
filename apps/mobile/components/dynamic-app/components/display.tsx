/**
 * Display Components for Dynamic App (React Native)
 *
 * Read-only visual components that render text, badges, icons, etc.
 */

import { View, Image as RNImage } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Text } from '@/components/ui/text'
import { formatDisplayText } from '../smart-format'
// Badge rendered with custom View+Text to avoid Gluestack's forced uppercase
import { Alert, AlertText, AlertIcon } from '@/components/ui/alert'
import { Progress, ProgressFilledTrack } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Divider } from '@/components/ui/divider'
import {
  AlertCircle, AlertTriangle, CheckCircle, Info, Mail, Search, Star,
  Clock, Calendar, MapPin, Phone, Globe, User, Heart, Bookmark,
  Download, Upload, Settings, ArrowRight, ArrowLeft, ArrowUp, ArrowDown,
  ChevronRight, ChevronLeft, ChevronUp, ChevronDown,
  Plus, Minus, X, Check, Loader2, ExternalLink, Copy, Trash2, Edit,
  Eye, EyeOff, Lock, Unlock, Bell, BellOff, Zap, Shield, TrendingUp,
  TrendingDown, DollarSign, Plane, Car, Home, Building, Package,
  type LucideIcon,
} from 'lucide-react-native'

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

const TEXT_COLOR_MAP: Record<string, string> = {
  muted: 'text-muted-foreground',
  accent: 'text-accent-foreground',
  secondary: 'text-secondary-foreground',
}

export function DynText({ text = '', variant = 'body', align, color, weight, className }: TextProps) {
  const alignClass = align ? `text-${align}` : ''
  const colorClass = color ? (TEXT_COLOR_MAP[color] || `text-${color}`) : ''
  const weightClass = weight ? `font-${weight}` : ''

  return (
    <Text className={cn(VARIANT_CLASSES[variant] || VARIANT_CLASSES.body, alignClass, colorClass, weightClass, className)}>
      {formatDisplayText(text)}
    </Text>
  )
}

const BADGE_BG_MAP: Record<string, string> = {
  default: 'bg-primary/15',
  secondary: 'bg-secondary',
  destructive: 'bg-destructive/15',
  outline: 'bg-muted',
}

const BADGE_TEXT_MAP: Record<string, string> = {
  default: 'text-primary',
  secondary: 'text-muted-foreground',
  destructive: 'text-destructive',
  outline: 'text-foreground',
}

interface BadgeProps {
  text?: string
  label?: string
  variant?: 'default' | 'secondary' | 'destructive' | 'outline'
  className?: string
}

export function DynBadge({ text, label, variant = 'default', className }: BadgeProps) {
  return (
    <View className={cn(
      'flex-row items-center self-start rounded-md px-2.5 py-0.5',
      BADGE_BG_MAP[variant] || BADGE_BG_MAP.default,
      className,
    )}>
      <Text className={cn(
        'text-xs font-medium',
        BADGE_TEXT_MAP[variant] || BADGE_TEXT_MAP.default,
      )}>
        {text || label}
      </Text>
    </View>
  )
}

function parseDimension(val: string | number | undefined): number | string | undefined {
  if (val == null) return undefined
  if (typeof val === 'number') return val
  if (typeof val === 'string' && val.endsWith('px')) return parseInt(val, 10)
  if (typeof val === 'string' && val.endsWith('%')) return val
  return parseInt(val as string, 10) || undefined
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
  if (!src) return null

  const resizeMode = fit === 'contain' ? 'contain' : fit === 'stretch' ? 'stretch' : 'cover'
  const w = parseDimension(width)
  const h = parseDimension(height)

  return (
    <RNImage
      source={{ uri: src }}
      accessibilityLabel={alt}
      className={cn(rounded && 'rounded-lg', className)}
      resizeMode={resizeMode}
      style={{
        width: w ?? '100%',
        height: h ?? 200,
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

const ICON_SIZE_MAP: Record<string, number> = {
  xs: 12,
  sm: 16,
  md: 20,
  lg: 24,
  xl: 32,
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
    return <Text className={cn('text-muted-foreground', className)}>?</Text>
  }
  const iconSize = ICON_SIZE_MAP[size] || 20
  return <IconComp size={iconSize} className={cn(color && (TEXT_COLOR_MAP[color] || `text-${color}`), className)} />
}

interface SeparatorProps {
  orientation?: 'horizontal' | 'vertical'
  className?: string
}

export function DynSeparator({ orientation = 'horizontal', className }: SeparatorProps) {
  return <Divider orientation={orientation} className={className} />
}

interface ProgressProps {
  value?: number
  max?: number
  className?: string
}

export function DynProgress({ value = 0, max = 100, className }: ProgressProps) {
  return (
    <Progress value={(value / max) * 100} className={className}>
      <ProgressFilledTrack />
    </Progress>
  )
}

interface SkeletonProps {
  width?: string | number
  height?: string | number
  rounded?: boolean
  className?: string
}

export function DynSkeleton({ width, height = 20, rounded, className }: SkeletonProps) {
  const w = parseDimension(width)
  const h = parseDimension(height)

  return (
    <Skeleton
      variant={rounded ? 'circular' : 'rounded'}
      className={cn(className)}
      style={{
        width: w ?? '100%',
        height: h ?? 20,
      }}
    />
  )
}

const ALERT_ACTION_MAP: Record<string, 'error' | 'warning' | 'success' | 'info' | 'muted'> = {
  default: 'muted',
  info: 'info',
  warning: 'warning',
  success: 'success',
  destructive: 'error',
  error: 'error',
}

const ALERT_ICON_MAP: Record<string, LucideIcon> = {
  default: Info,
  info: Info,
  warning: AlertTriangle,
  success: CheckCircle,
  destructive: AlertCircle,
  error: AlertCircle,
}

interface AlertProps {
  title?: string
  description?: string
  variant?: string
  icon?: string
  className?: string
}

export function DynAlert({ title, description, variant = 'default', icon, className }: AlertProps) {
  const action = ALERT_ACTION_MAP[variant] || 'muted'
  const IconComp = icon ? ICON_MAP[icon.toLowerCase()] : (ALERT_ICON_MAP[variant] || Info)

  return (
    <Alert action={action} className={className}>
      {IconComp && <AlertIcon as={IconComp} />}
      <View className="flex-1 flex-col">
        {title && <AlertText className="font-semibold">{title}</AlertText>}
        {description && <AlertText>{description}</AlertText>}
      </View>
    </Alert>
  )
}

export { ICON_MAP }
