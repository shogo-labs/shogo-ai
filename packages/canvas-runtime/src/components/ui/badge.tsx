import { type HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

const variants: Record<string, string> = {
  default: 'bg-primary/15 text-primary border-transparent',
  secondary: 'bg-secondary text-secondary-foreground border-transparent',
  destructive: 'bg-destructive/15 text-destructive border-transparent',
  outline: 'bg-transparent text-foreground border-border',
}

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: keyof typeof variants
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors',
        variants[variant] || variants.default,
        className,
      )}
      {...props}
    />
  )
}
