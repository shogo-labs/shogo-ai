import { type HTMLAttributes, forwardRef } from 'react'
import { cn } from '@/lib/cn'

const alertVariants: Record<string, string> = {
  default: 'bg-background text-foreground border-border',
  destructive: 'border-destructive/50 text-destructive [&>svg]:text-destructive',
  success: 'border-emerald-500/50 text-emerald-700 dark:text-emerald-400',
}

interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  variant?: string
}

export const Alert = forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant = 'default', ...props }, ref) => (
    <div
      ref={ref}
      role="alert"
      className={cn(
        'relative w-full rounded-lg border p-4 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg~*]:pl-7',
        alertVariants[variant] || alertVariants.default,
        className,
      )}
      {...props}
    />
  ),
)

export const AlertTitle = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h5 ref={ref} className={cn('mb-1 font-medium leading-none tracking-tight', className)} {...props} />
  ),
)

export const AlertDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('text-sm [&_p]:leading-relaxed', className)} {...props} />
  ),
)
