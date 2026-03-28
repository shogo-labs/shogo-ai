import { type HTMLAttributes, forwardRef } from 'react'
import { cn } from '@/lib/cn'

interface ProgressProps extends HTMLAttributes<HTMLDivElement> {
  value?: number
  max?: number
}

export const Progress = forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value = 0, max = 100, ...props }, ref) => {
    const pct = Math.min(Math.max((value / max) * 100, 0), 100)
    return (
      <div ref={ref} className={cn('relative h-2 w-full overflow-hidden rounded-full bg-muted', className)} {...props}>
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
    )
  },
)
