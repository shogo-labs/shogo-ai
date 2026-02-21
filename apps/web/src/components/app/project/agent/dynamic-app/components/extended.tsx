/**
 * Extended Components for Dynamic App
 *
 * Tabs and Accordion components that use shadcn primitives.
 */

import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { ChevronDown } from 'lucide-react'

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

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
  const defaultValue = defaultTab || tabs[0]?.id || ''
  const childArray = Array.isArray(children) ? children : children ? [children] : []

  return (
    <Tabs defaultValue={defaultValue} className={cn(className)}>
      {tabs.length > 0 && (
        <TabsList>
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>{tab.label}</TabsTrigger>
          ))}
        </TabsList>
      )}
      {childArray.map((child, i) => {
        const tabId = tabs[i]?.id || `tab-${i}`
        return (
          <TabsContent key={tabId} value={tabId}>
            {child}
          </TabsContent>
        )
      })}
    </Tabs>
  )
}

interface DynTabPanelProps {
  children?: ReactNode
  className?: string
}

export function DynTabPanel({ children, className }: DynTabPanelProps) {
  return <div className={cn(className)}>{children}</div>
}

// ---------------------------------------------------------------------------
// Accordion
// ---------------------------------------------------------------------------

interface DynAccordionProps {
  children?: ReactNode
  className?: string
}

export function DynAccordion({ children, className }: DynAccordionProps) {
  return <div className={cn('divide-y border rounded-md', className)}>{children}</div>
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
    <div className={cn(className)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors"
      >
        <span>{title}</span>
        <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="px-4 pb-3 text-sm">
          {children}
        </div>
      )}
    </div>
  )
}
