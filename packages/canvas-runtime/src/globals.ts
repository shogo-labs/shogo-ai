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

// Lucide icons
import * as LucideIcons from 'lucide-react'

// Shogo SDK (lightweight client-side pieces)
import { createClient, HttpClient, OptimisticStore } from '@shogo-ai/sdk'

// ---------------------------------------------------------------------------
// Import map — maps package names to their exports for Sucrase-compiled
// `require()` calls. This lets agent code use standard `import` statements.
// ---------------------------------------------------------------------------

const reactExports = {
  default: React,
  React,
  createElement: React.createElement,
  Fragment,
  useState, useEffect, useMemo, useCallback, useRef, useReducer,
}

const uiCard = { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter }
const uiButton = { Button }
const uiBadge = { Badge }
const uiInput = { Input }
const uiLabel = { Label }
const uiTextarea = { Textarea }
const uiCheckbox = { Checkbox }
const uiSwitch = { Switch }
const uiSelect = { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
const uiTabs = { Tabs, TabsList, TabsTrigger, TabsContent }
const uiTable = { Table, TableHeader, TableBody, TableRow, TableHead, TableCell }
const uiDialog = { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter }
const uiAlert = { Alert, AlertTitle, AlertDescription }
const uiAccordion = { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
const uiProgress = { Progress }
const uiSeparator = { Separator }
const uiScrollArea = { ScrollArea }
const uiSkeleton = { Skeleton }
const uiTooltip = { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent }
const uiAvatar = { Avatar, AvatarImage, AvatarFallback }
const uiDropdown = { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem }
const uiSheet = { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle }
const uiPopover = { Popover, PopoverTrigger, PopoverContent }

const rechartsExports = {
  ResponsiveContainer, LineChart, BarChart, AreaChart, PieChart,
  Line, Bar, Area, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip: RechartsTooltip, Legend,
}

const canvasLayout = { Row, Column, Grid, CanvasCard, CanvasScrollArea }
const canvasDisplay = { DynText, DynBadge, DynImage, DynIcon, DynSeparator, DynProgress, DynSkeleton, DynAlert }
const canvasData = { Metric, DynTable, DynChart, DataList }
const canvasExtended = { DynTabs, DynTabPanel, DynAccordion, DynAccordionItem }

const sdkExports = { createClient, HttpClient, OptimisticStore }

function buildImportMap(data: unknown, onAction: (name: string, context?: Record<string, unknown>) => void) {
  const map: Record<string, Record<string, unknown>> = {
    'react': reactExports,
    'recharts': rechartsExports,
    'lucide-react': { ...LucideIcons },
    '@/lib/cn': { cn, default: cn },
    '@/components/ui/card': uiCard,
    '@/components/ui/button': uiButton,
    '@/components/ui/badge': uiBadge,
    '@/components/ui/input': uiInput,
    '@/components/ui/label': uiLabel,
    '@/components/ui/textarea': uiTextarea,
    '@/components/ui/checkbox': uiCheckbox,
    '@/components/ui/switch': uiSwitch,
    '@/components/ui/select': uiSelect,
    '@/components/ui/tabs': uiTabs,
    '@/components/ui/table': uiTable,
    '@/components/ui/dialog': uiDialog,
    '@/components/ui/alert': uiAlert,
    '@/components/ui/accordion': uiAccordion,
    '@/components/ui/progress': uiProgress,
    '@/components/ui/separator': uiSeparator,
    '@/components/ui/scroll-area': uiScrollArea,
    '@/components/ui/skeleton': uiSkeleton,
    '@/components/ui/tooltip': uiTooltip,
    '@/components/ui/avatar': uiAvatar,
    '@/components/ui/dropdown-menu': uiDropdown,
    '@/components/ui/sheet': uiSheet,
    '@/components/ui/popover': uiPopover,
    '@/components/canvas/layout': canvasLayout,
    '@/components/canvas/display': canvasDisplay,
    '@/components/canvas/data': canvasData,
    '@/components/canvas/extended': canvasExtended,
    '@/canvas/data': { default: data, data },
    '@/canvas/actions': { default: onAction, onAction },
    '@shogo-ai/sdk': sdkExports,
  }
  return map
}

// ---------------------------------------------------------------------------
// Flat scope — every symbol available as a top-level variable.
// Used for inline-mode code (no imports/exports).
// ---------------------------------------------------------------------------

function buildFlatScope(data: unknown, onAction: (name: string, context?: Record<string, unknown>) => void): Record<string, unknown> {
  const scope: Record<string, unknown> = {
    React,
    h: React.createElement,
    Fragment,
    useState, useEffect, useMemo, useCallback, useRef, useReducer,

    Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter,
    Button, Badge, Input, Label, Textarea, Checkbox, Switch,
    Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
    Tabs, TabsList, TabsTrigger, TabsContent,
    Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
    Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
    Alert, AlertTitle, AlertDescription,
    Accordion, AccordionItem, AccordionTrigger, AccordionContent,
    Progress, Separator, ScrollArea, Skeleton,
    Tooltip, TooltipProvider, TooltipTrigger, TooltipContent,
    Avatar, AvatarImage, AvatarFallback,
    DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
    Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle,
    Popover, PopoverTrigger, PopoverContent,

    Column, Row, Grid, CanvasCard, CanvasScrollArea,
    Metric, DataList,
    DynText, DynBadge, DynImage, DynIcon,
    DynTable, DynChart,
    DynSeparator, DynProgress, DynSkeleton, DynAlert,
    DynTabs, DynTabPanel, DynAccordion, DynAccordionItem,

    ResponsiveContainer,
    LineChart, BarChart, AreaChart, PieChart,
    Line, Bar, Area, Pie, Cell,
    XAxis, YAxis, CartesianGrid, RechartsTooltip, Legend,

    cn,
    data,
    onAction,

    createClient, HttpClient, OptimisticStore,
  }

  for (const [name, icon] of Object.entries(LucideIcons)) {
    if (typeof icon === 'function' && name[0] === name[0].toUpperCase() && name !== 'createLucideIcon') {
      scope[name] = icon
    }
  }

  return scope
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CanvasScope {
  importMap: Record<string, Record<string, unknown>>
  flatScope: Record<string, unknown>
}

export function getScope(
  data: unknown,
  onAction: (name: string, context?: Record<string, unknown>) => void,
): CanvasScope {
  return {
    importMap: buildImportMap(data, onAction),
    flatScope: buildFlatScope(data, onAction),
  }
}
