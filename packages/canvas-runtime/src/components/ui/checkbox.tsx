import { type InputHTMLAttributes, forwardRef } from 'react'
import { cn } from '@/lib/cn'
import { Check } from 'lucide-react'

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, checked, onCheckedChange, ...props }, ref) => (
    <label className={cn('inline-flex items-center', className)}>
      <input
        type="checkbox"
        ref={ref}
        checked={checked}
        onChange={(e) => onCheckedChange?.(e.target.checked)}
        className="sr-only"
        {...props}
      />
      <div
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary',
          checked ? 'bg-primary text-primary-foreground' : 'bg-background',
        )}
      >
        {checked && <Check size={12} />}
      </div>
    </label>
  ),
)
