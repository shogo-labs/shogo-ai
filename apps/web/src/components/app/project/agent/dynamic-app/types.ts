/**
 * Dynamic App Protocol Types (Frontend)
 *
 * Mirrors packages/agent-runtime/src/dynamic-app-types.ts.
 * Defines the JSON message protocol for agent-driven UI rendering.
 */

// ---------------------------------------------------------------------------
// Data Binding
// ---------------------------------------------------------------------------

export type DynamicValue<T = string> = T | { path: string }

export function isDynamicPath(val: unknown): val is { path: string } {
  return typeof val === 'object' && val !== null && 'path' in val && typeof (val as any).path === 'string'
}

// ---------------------------------------------------------------------------
// Component Definitions
// ---------------------------------------------------------------------------

export type ComponentType =
  | 'Row' | 'Column' | 'Grid' | 'Card'
  | 'Tabs' | 'TabPanel' | 'Accordion' | 'AccordionItem' | 'ScrollArea'
  | 'Text' | 'Badge' | 'Image' | 'Icon' | 'Separator' | 'Progress' | 'Skeleton' | 'Alert'
  | 'Table' | 'Metric' | 'Chart' | 'DataList'
  | 'Button' | 'TextField' | 'Select' | 'Checkbox' | 'ChoicePicker'

export interface ComponentDefinition {
  id: string
  component: ComponentType
  child?: string
  children?: string[] | { path: string; templateId: string }
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Action Events (user interaction -> agent)
// ---------------------------------------------------------------------------

export interface ActionEvent {
  surfaceId: string
  name: string
  context?: Record<string, unknown>
  timestamp: string
}

// ---------------------------------------------------------------------------
// Protocol Messages (server -> client via SSE)
// ---------------------------------------------------------------------------

export interface CreateSurfaceMessage {
  type: 'createSurface'
  surfaceId: string
  title?: string
  theme?: Record<string, string>
}

export interface UpdateComponentsMessage {
  type: 'updateComponents'
  surfaceId: string
  components: ComponentDefinition[]
}

export interface UpdateDataMessage {
  type: 'updateData'
  surfaceId: string
  path?: string
  value: unknown
}

export interface DeleteSurfaceMessage {
  type: 'deleteSurface'
  surfaceId: string
}

export type DynamicAppMessage =
  | CreateSurfaceMessage
  | UpdateComponentsMessage
  | UpdateDataMessage
  | DeleteSurfaceMessage

// ---------------------------------------------------------------------------
// Surface State (client-side)
// ---------------------------------------------------------------------------

export interface SurfaceState {
  surfaceId: string
  title?: string
  theme?: Record<string, string>
  components: Map<string, ComponentDefinition>
  dataModel: Record<string, unknown>
  createdAt: string
  updatedAt: string
}
