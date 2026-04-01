import { useState, createContext, useContext, type HTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { ChevronDown } from 'lucide-react'

const AccordionItemContext = createContext<{ open: boolean; toggle: () => void }>({
  open: false,
  toggle: () => {},
})

export function Accordion({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-lg border border-border', className)} {...props}>
      {children}
    </div>
  )
}

interface AccordionItemProps extends HTMLAttributes<HTMLDivElement> {
  value?: string
  defaultOpen?: boolean
}

export function AccordionItem({ defaultOpen = false, className, children, ...props }: AccordionItemProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <AccordionItemContext.Provider value={{ open, toggle: () => setOpen(!open) }}>
      <div className={cn('border-b border-border last:border-0', className)} {...props}>
        {children}
      </div>
    </AccordionItemContext.Provider>
  )
}

export function AccordionTrigger({ className, children, ...props }: HTMLAttributes<HTMLButtonElement>) {
  const { open, toggle } = useContext(AccordionItemContext)

  return (
    <button
      className={cn('flex w-full items-center justify-between px-4 py-3 text-sm font-medium transition-all hover:underline', className)}
      onClick={toggle}
      {...props}
    >
      {children}
      <ChevronDown size={16} className={cn('transition-transform', open && 'rotate-180')} />
    </button>
  )
}

export function AccordionContent({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const { open } = useContext(AccordionItemContext)
  if (!open) return null

  return (
    <div className={cn('px-4 pb-3 text-sm', className)} {...props}>
      {children}
    </div>
  )
}
