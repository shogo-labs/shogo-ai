import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { ChevronDown } from 'lucide-react'

interface TabDef {
  id: string
  label: string
}

interface DynTabsProps {
  tabs?: TabDef[]
  defaultTab?: string
  children?: ReactNode
  className?: string
}

export function DynTabs({ tabs = [], defaultTab, children, className }: DynTabsProps) {
  const [activeTab, setActiveTab] = useState(defaultTab || tabs[0]?.id || '')
  const childArray = Array.isArray(children) ? children : children ? [children] : []
  const activeIdx = tabs.findIndex((t) => t.id === activeTab)

  return (
    <div className={cn(className)}>
      {tabs.length > 0 && (
        <div className="flex border-b border-border">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'px-4 py-2.5 text-sm font-medium',
                activeTab === tab.id
                  ? 'border-b-2 border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}
      <div className="pt-4">
        {activeIdx >= 0 && activeIdx < childArray.length ? childArray[activeIdx] : childArray[0]}
      </div>
    </div>
  )
}

interface DynTabPanelProps {
  title?: string
  children?: ReactNode
  className?: string
}

export function DynTabPanel({ children, className }: DynTabPanelProps) {
  return <div className={cn('flex flex-col gap-4', className)}>{children}</div>
}

interface DynAccordionProps {
  children?: ReactNode
  className?: string
}

export function DynAccordion({ children, className }: DynAccordionProps) {
  return <div className={cn('rounded-lg border border-border', className)}>{children}</div>
}

interface DynAccordionItemProps {
  title?: string
  defaultOpen?: boolean
  children?: ReactNode
  className?: string
}

export function DynAccordionItem({ title, defaultOpen = false, children, className }: DynAccordionItemProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className={cn('border-b border-border last:border-0', className)}>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3"
      >
        <span className="text-sm font-medium flex-1 text-left">{title}</span>
        <ChevronDown size={16} className={cn('text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="px-4 pb-3">
          {children}
        </div>
      )}
    </div>
  )
}
