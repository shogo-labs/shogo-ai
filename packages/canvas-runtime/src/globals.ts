import React, {
  useState, useEffect, useMemo, useCallback, useRef, useReducer, Fragment,
} from 'react'

import { cn } from '@/lib/cn'

// shadcn/ui components
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'

// Canvas components (web ports)
import { Row, Column, Grid, CanvasCard, CanvasScrollArea } from '@/components/canvas/layout'
import { DynText, DynBadge, DynImage, DynIcon, DynSeparator, DynProgress, DynSkeleton, DynAlert } from '@/components/canvas/display'
import { Metric, DynTable, DynChart, DataList } from '@/components/canvas/data'
import { DynTabs, DynTabPanel, DynAccordion, DynAccordionItem } from '@/components/canvas/extended'

// Recharts
import {
  ResponsiveContainer, LineChart, BarChart, AreaChart, PieChart,
  Line, Bar, Area, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend,
} from 'recharts'

// Lucide icons — export commonly used ones as named globals
import * as LucideIcons from 'lucide-react'

/**
 * Names and values for every global passed to agent code via new Function().
 * Order matters: names[i] corresponds to values[i].
 */
export function getGlobals(data: unknown, onAction: (name: string, context?: Record<string, unknown>) => void) {
  const names: string[] = []
  const values: unknown[] = []

  function add(name: string, value: unknown) {
    names.push(name)
    values.push(value)
  }

  // React core
  add('React', React)
  add('h', React.createElement)
  add('Fragment', Fragment)
  add('useState', useState)
  add('useEffect', useEffect)
  add('useMemo', useMemo)
  add('useCallback', useCallback)
  add('useRef', useRef)
  add('useReducer', useReducer)

  // shadcn/ui
  add('Card', Card); add('CardHeader', CardHeader); add('CardTitle', CardTitle)
  add('CardDescription', CardDescription); add('CardContent', CardContent); add('CardFooter', CardFooter)
  add('Button', Button); add('Badge', Badge); add('Input', Input); add('Label', Label)
  add('Textarea', Textarea); add('Checkbox', Checkbox); add('Switch', Switch)
  add('Select', Select); add('SelectTrigger', SelectTrigger); add('SelectValue', SelectValue)
  add('SelectContent', SelectContent); add('SelectItem', SelectItem)
  add('Tabs', Tabs); add('TabsList', TabsList); add('TabsTrigger', TabsTrigger); add('TabsContent', TabsContent)
  add('Table', Table); add('TableHeader', TableHeader); add('TableBody', TableBody)
  add('TableRow', TableRow); add('TableHead', TableHead); add('TableCell', TableCell)
  add('Dialog', Dialog); add('DialogTrigger', DialogTrigger); add('DialogContent', DialogContent)
  add('DialogHeader', DialogHeader); add('DialogTitle', DialogTitle)
  add('DialogDescription', DialogDescription); add('DialogFooter', DialogFooter)
  add('Alert', Alert); add('AlertTitle', AlertTitle); add('AlertDescription', AlertDescription)
  add('Accordion', Accordion); add('AccordionItem', AccordionItem)
  add('AccordionTrigger', AccordionTrigger); add('AccordionContent', AccordionContent)
  add('Progress', Progress); add('Separator', Separator); add('ScrollArea', ScrollArea); add('Skeleton', Skeleton)
  add('Tooltip', Tooltip); add('TooltipProvider', TooltipProvider)
  add('TooltipTrigger', TooltipTrigger); add('TooltipContent', TooltipContent)
  add('Avatar', Avatar); add('AvatarImage', AvatarImage); add('AvatarFallback', AvatarFallback)
  add('DropdownMenu', DropdownMenu); add('DropdownMenuTrigger', DropdownMenuTrigger)
  add('DropdownMenuContent', DropdownMenuContent); add('DropdownMenuItem', DropdownMenuItem)
  add('Sheet', Sheet); add('SheetTrigger', SheetTrigger); add('SheetContent', SheetContent)
  add('SheetHeader', SheetHeader); add('SheetTitle', SheetTitle)
  add('Popover', Popover); add('PopoverTrigger', PopoverTrigger); add('PopoverContent', PopoverContent)

  // Canvas components
  add('Column', Column); add('Row', Row); add('Grid', Grid)
  add('CanvasCard', CanvasCard); add('CanvasScrollArea', CanvasScrollArea)
  add('Metric', Metric); add('DataList', DataList)
  add('DynText', DynText); add('DynBadge', DynBadge); add('DynImage', DynImage); add('DynIcon', DynIcon)
  add('DynTable', DynTable); add('DynChart', DynChart)
  add('DynSeparator', DynSeparator); add('DynProgress', DynProgress)
  add('DynSkeleton', DynSkeleton); add('DynAlert', DynAlert)
  add('DynTabs', DynTabs); add('DynTabPanel', DynTabPanel)
  add('DynAccordion', DynAccordion); add('DynAccordionItem', DynAccordionItem)

  // Recharts
  add('ResponsiveContainer', ResponsiveContainer)
  add('LineChart', LineChart); add('BarChart', BarChart); add('AreaChart', AreaChart); add('PieChart', PieChart)
  add('Line', Line); add('Bar', Bar); add('Area', Area); add('Pie', Pie); add('Cell', Cell)
  add('XAxis', XAxis); add('YAxis', YAxis); add('CartesianGrid', CartesianGrid)
  add('RechartsTooltip', RechartsTooltip); add('Legend', Legend)

  // Lucide icons — add all exported icons
  for (const [name, icon] of Object.entries(LucideIcons)) {
    if (typeof icon === 'function' && name[0] === name[0].toUpperCase() && name !== 'createLucideIcon') {
      add(name, icon)
    }
  }

  // Utilities
  add('cn', cn)
  add('data', data)
  add('onAction', onAction)

  return { names, values }
}
