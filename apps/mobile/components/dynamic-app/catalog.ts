// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Component Catalog (React Native)
 *
 * Registry mapping component type names to their React Native implementations.
 * The renderer looks up components by type string and renders them with
 * resolved props.
 */

import type { ComponentType as ReactComponentType } from 'react'
import type { ComponentType } from './types'

// Layout
import { DynRow } from './components/layout'
import { DynColumn } from './components/layout'
import { DynGrid } from './components/layout'
import { DynCard } from './components/layout'
import { DynScrollArea } from './components/layout'

// Display
import { DynText } from './components/display'
import { DynBadge } from './components/display'
import { DynImage } from './components/display'
import { DynIcon } from './components/display'
import { DynSeparator } from './components/display'
import { DynProgress } from './components/display'
import { DynSkeleton } from './components/display'
import { DynAlert } from './components/display'

// Interactive
import { DynButton } from './components/interactive'
import { DynTextField } from './components/interactive'
import { DynSelect } from './components/interactive'
import { DynCheckbox } from './components/interactive'
import { DynChoicePicker } from './components/interactive'

// Data
import { DynMetric } from './components/data'
import { DynTable } from './components/data'
import { DynChart } from './components/data'
import { DynDataList } from './components/data'

// Extended (Tabs, Accordion)
import { DynTabs, DynTabPanel } from './components/extended'
import { DynAccordion, DynAccordionItem } from './components/extended'

export interface CatalogEntry {
  component: ReactComponentType<any>
  hasChildren?: boolean
}

export const COMPONENT_CATALOG: Record<ComponentType, CatalogEntry> = {
  // Layout
  Row: { component: DynRow, hasChildren: true },
  Column: { component: DynColumn, hasChildren: true },
  Grid: { component: DynGrid, hasChildren: true },
  Card: { component: DynCard, hasChildren: true },
  ScrollArea: { component: DynScrollArea, hasChildren: true },
  Tabs: { component: DynTabs, hasChildren: true },
  TabPanel: { component: DynTabPanel, hasChildren: true },
  Accordion: { component: DynAccordion, hasChildren: true },
  AccordionItem: { component: DynAccordionItem, hasChildren: true },

  // Display
  Text: { component: DynText },
  Badge: { component: DynBadge },
  Image: { component: DynImage },
  Icon: { component: DynIcon },
  Separator: { component: DynSeparator },
  Progress: { component: DynProgress },
  Skeleton: { component: DynSkeleton },
  Alert: { component: DynAlert },

  // Data
  Table: { component: DynTable },
  Metric: { component: DynMetric },
  Chart: { component: DynChart },
  DataList: { component: DynDataList, hasChildren: true },

  // Interactive
  Button: { component: DynButton },
  TextField: { component: DynTextField },
  Select: { component: DynSelect },
  Checkbox: { component: DynCheckbox },
  ChoicePicker: { component: DynChoicePicker },
}
